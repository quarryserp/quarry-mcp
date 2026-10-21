import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GOOGLE_COUNTRIES,
  GOOGLE_LANGUAGES,
  QuarryClient,
  QuarryError,
  type GoogleCountry,
  type GoogleLanguage,
  type V1Search,
} from "@quarryserp/client";
import { z } from "zod";

// Accept any casing and "_" for "-" (like the API), then map to the canonical code.
function canonical<T extends string>(codes: readonly T[], label: string) {
  const byLower = new Map(codes.map((code) => [code.toLowerCase(), code]));
  return z
    .string()
    .trim()
    .transform((value, ctx) => {
      const code = byLower.get(value.toLowerCase().replace("_", "-"));
      if (!code) {
        ctx.addIssue({ code: "custom", message: `Unknown ${label} code "${value}".` });
        return z.NEVER;
      }
      return code;
    });
}

export const searchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Search text. Required unless cursor is provided."),
    type: z
      .enum(["web", "news", "videos", "images", "shopping", "places"])
      .default("web")
      .describe("Google search vertical."),
    lang: canonical<GoogleLanguage>(GOOGLE_LANGUAGES, "language")
      .optional()
      .describe("Google interface language code, e.g. en, de, pt-BR. Omit for Google default."),
    country: canonical<GoogleCountry>(GOOGLE_COUNTRIES, "country")
      .optional()
      .describe(
        "Lowercase Google country code, e.g. de for Germany or us. Omit for Google default.",
      ),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Opaque nextCursor from an earlier result. Replaces query, type, lang, country and resolveLinks.",
      ),
    mode: z
      .enum(["sync", "async"])
      .default("sync")
      .describe(
        "Initial API request mode. This tool always polls until completion in either mode.",
      ),
    cache: z
      .boolean()
      .default(true)
      .describe("Reuse cached searches for free; false requests a fresh search."),
    resolveLinks: z
      .enum(["organic", "all", "none"])
      .optional()
      .describe("Which Google redirect links to resolve. Omit to use the server default."),
    thumbnails: z
      .boolean()
      .default(false)
      .describe(
        "Include potentially large thumbnails and favicons. Disabled by default to save context.",
      ),
    imageFallback: z
      .enum(["none", "page"])
      .default("none")
      .describe(
        "For images: page fills missing image URLs from source page metadata; may differ from the Google image.",
      ),
  })
  .refine((input) => Boolean(input.query || input.cursor), {
    message: "Provide query or cursor.",
    path: ["query"],
  });

export function clientFromEnv(env: Record<string, string | undefined> = process.env): QuarryClient {
  const apiKey = env.QUARRY_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      "QUARRY_API_KEY is required. Set it to your Quarry API key before starting the MCP server.",
    );
  return new QuarryClient({ apiKey, baseUrl: env.QUARRY_BASE_URL });
}

// Keep machine-readable results bounded too. URLs and cursors remain intact.
function compact(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (/url|cursor/i.test(key) && !value.startsWith("data:")) return value;
    const limit = key === "text" ? 4000 : 800;
    return value.length > limit ? `${value.slice(0, limit)}… [truncated]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => compact(entry, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, compact(entry, name)]),
    );
  return value;
}

export function formatSearch(search: V1Search): CallToolResult {
  const result = compact(search) as Record<string, unknown>;
  const lines = [
    `Search ${search.id}: ${search.status} — ${search.query.text} (${search.query.type}).`,
  ];
  const r = search.results;
  if (r) {
    let count = 0;
    for (const kind of [
      "organic",
      "news",
      "videos",
      "images",
      "shopping",
      "places",
      "topStories",
    ] as const) {
      const entries = r[kind];
      if (!entries?.length) continue;
      count += entries.length;
      lines.push(`${kind}:`);
      for (const entry of entries.slice(0, 5)) {
        const item = entry as unknown as Record<string, unknown>;
        lines.push(
          `${item.rank ?? "•"}. ${String(item.title ?? "Untitled").slice(0, 200)} — ${item.url ?? item.pageUrl ?? item.website ?? item.mapsUrl ?? item.imageUrl ?? ""}`,
        );
        for (const field of [
          "snippet",
          "source",
          "publishedText",
          "address",
          "rating",
          "priceText",
          "duration",
        ]) {
          if (item[field] !== undefined)
            lines.push(`  ${field}: ${String(item[field]).slice(0, 400)}`);
        }
      }
    }
    if (!count) lines.push("No result listings returned.");
    if (r.aiOverview?.text) lines.push(`AI Overview: ${r.aiOverview.text.slice(0, 2000)}`);
    if (r.questions.length)
      lines.push(
        `Questions: ${r.questions
          .slice(0, 5)
          .map((q) => q.slice(0, 300))
          .join(" | ")}`,
      );
    if (r.knowledgePanel)
      lines.push(
        `Knowledge panel: ${r.knowledgePanel.title} — ${r.knowledgePanel.description?.slice(0, 600) ?? ""}`,
      );
    if (r.relatedQueries.length)
      lines.push(
        `Related queries: ${r.relatedQueries
          .slice(0, 5)
          .map((q) => q.query.slice(0, 200))
          .join(" | ")}`,
      );
  }
  if (search.pollUrl)
    lines.push(
      `Poll: ${search.pollUrl}; retryAfterMs: ${search.retryAfterMs ?? "unspecified"}. Use quarry_get_search with this id.`,
    );
  if (search.pagination?.nextCursor) lines.push(`nextCursor: ${search.pagination.nextCursor}`);
  if (search.meta.warning) lines.push(`Warning: ${search.meta.warning}`);
  lines.push(
    `Credits: ${search.meta.cached ? "cached repeat (free)" : "each new search costs 1 credit; repeats are free"}. Summary shows up to 5 listings per type; structured JSON up to 20 items per array, with long text truncated.`,
  );
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: result };
}

export function toolError(error: unknown, apiKey?: string): CallToolResult {
  const quarry = error instanceof QuarryError;
  const code = quarry ? error.code : "INTERNAL_ERROR";
  const hints: Record<string, string> = {
    RATE_LIMITED:
      "Retry after the server's Retry-After interval. The client does not expose that header; use exponential backoff if no interval is available.",
    QUOTA_EXCEEDED:
      "Upgrade your plan or wait for the next monthly quota reset; do not retry immediately.",
    UNAUTHORIZED: "Check QUARRY_API_KEY in the MCP server configuration.",
    FORBIDDEN: "This key does not have permission for the requested operation.",
    INVALID_PARAMETER: "Correct the tool arguments before retrying.",
    INVALID_CURSOR: "Run the original query again to obtain a fresh cursor.",
    NOT_FOUND: "Check the search id.",
  };
  const message = quarry ? error.message : "Unexpected Quarry MCP error.";
  const payload = {
    code,
    message: apiKey ? message.replaceAll(apiKey, "[redacted]") : message,
    retryable: quarry && error.retryable,
    hint: hints[code] ?? "Retry with exponential backoff only when retryable is true.",
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function createServer(client: QuarryClient): McpServer {
  const server = new McpServer({ name: "quarry", version: "0.1.1" });
  const run = async (action: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await action();
    } catch (error) {
      return toolError(error, client.apiKey);
    }
  };
  server.registerTool(
    "quarry_search",
    {
      description:
        "Search Google via Quarry for current web, news, videos, images, shopping or places results. Always waits for completion. Cite the returned source URLs. Each new search costs 1 credit; cached repeats are free. Use nextCursor to request another page.",
      inputSchema: searchSchema,
    },
    async (input, extra) =>
      run(async () => formatSearch(await client.searchAndWait(input, { signal: extra.signal }))),
  );
  server.registerTool(
    "quarry_get_search",
    {
      description:
        "Retrieve an existing Quarry search by id, including its status and results. For pending ids, poll again after retryAfterMs. Does not create a new search.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Search id returned by Quarry, including async/pending searches."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }, extra) =>
      run(async () =>
        formatSearch(await client.get(id, { thumbnails: false, signal: extra.signal })),
      ),
  );
  server.registerTool(
    "quarry_account",
    {
      description:
        "Read the current key's plan limits and monthly credit usage. Null limits mean unlimited. Use before estimating whether searches fit the remaining quota.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_, extra) =>
      run(async () => {
        const account = await client.account({ signal: extra.signal });
        return {
          content: [
            {
              type: "text",
              text: `Monthly usage (${account.usage.month}): ${account.usage.used} used, ${account.usage.remaining ?? "unlimited"} remaining. Plan: ${account.plan.monthlyQuota ?? "unlimited"} credits/month; ${account.plan.ratePerMinute ?? "unlimited"} requests/minute.`,
            },
          ],
          structuredContent: { ...account },
        };
      }),
  );
  return server;
}
