import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { QuarryClient, QuarryError, type V1Search } from "@quarryserp/client";
import { clientFromEnv, createServer, formatSearch, searchSchema, toolError } from "../src/server";

const completed = (): V1Search => ({
  id: "test_search",
  status: "completed",
  query: { text: "coffee", type: "web", engine: "google" },
  results: {
    organic: [
      {
        rank: 1,
        title: "Coffee guide",
        url: "https://example.com/coffee",
        snippet: "Brew better coffee.",
      },
    ],
    questions: ["How to brew coffee?"],
    relatedQueries: [],
    aiOverview: { text: "Coffee is brewed.", blocks: [] },
  },
  pagination: { hasNext: true, nextCursor: "opaque-cursor" },
  meta: { cached: false, createdAt: "2026-10-21T00:00:00Z" },
});
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function connect(handler: (url: URL, init?: RequestInit) => Response) {
  const requests: URL[] = [];
  const quarry = new QuarryClient({
    apiKey: "test-secret",
    baseUrl: "http://quarry.invalid",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-secret");
      return handler(url, init);
    }) as typeof fetch,
  });
  const server = createServer(quarry);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(
    () => server.close(),
    () => client.close(),
  );
  return { client, requests };
}
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

describe("Quarry MCP", () => {
  test("registers three tools with descriptive schemas and defaults", async () => {
    const { client } = await connect(() => Response.json(completed()));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "quarry_search",
      "quarry_get_search",
      "quarry_account",
    ]);
    const properties = tools[0]!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.thumbnails!.default).toBe(false);
    expect(properties.type!.enum).toEqual([
      "web",
      "news",
      "videos",
      "images",
      "shopping",
      "places",
    ]);
    for (const field of Object.values(properties)) expect(field.description).toBeTruthy();
    expect(tools[1]!.inputSchema.required).toContain("id");
    expect(searchSchema.safeParse({}).success).toBe(false);
    expect(searchSchema.safeParse({ type: "invalid", query: "coffee" }).success).toBe(false);
    expect(searchSchema.parse({ cursor: "cursor" }).thumbnails).toBe(false);
    const invalid = await client.callTool({ name: "quarry_search", arguments: {} });
    expect(invalid.isError).toBe(true);
  });

  test("formats web results, AI Overview, questions, cursor and credits", async () => {
    const { client, requests } = await connect(() => Response.json(completed()));
    const result = await client.callTool({
      name: "quarry_search",
      arguments: { query: "coffee", country: "de" },
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("1. Coffee guide — https://example.com/coffee");
    expect(textOf(result)).toContain("Brew better coffee.");
    expect(textOf(result)).toContain("AI Overview: Coffee is brewed.");
    expect(textOf(result)).toContain("How to brew coffee?");
    expect(textOf(result)).toContain("nextCursor: opaque-cursor");
    expect(textOf(result)).toContain("1 credit");
    expect(result.structuredContent).toEqual(completed());
    expect(requests[0]!.searchParams.get("thumbnails")).toBe("false");
    expect(requests[0]!.searchParams.get("country")).toBe("de");
  });

  test("formats news and cached results", async () => {
    const search = completed();
    search.query.type = "news";
    search.meta.cached = true;
    search.results = {
      organic: [],
      questions: [],
      relatedQueries: [],
      news: [
        {
          rank: 1,
          title: "Coffee harvest",
          url: "https://example.com/news",
          source: "Newsroom",
          publishedText: "today",
          snippet: "Harvest begins.",
        },
      ],
    };
    const { client } = await connect(() => Response.json(search));
    const result = await client.callTool({
      name: "quarry_search",
      arguments: { query: "coffee", type: "news" },
    });
    expect(textOf(result)).toContain("news:");
    expect(textOf(result)).toContain("Newsroom");
    expect(textOf(result)).toContain("Harvest begins.");
    expect(textOf(result)).toContain("cached repeat (free)");
  });

  test("formats places and empty results", () => {
    const search = completed();
    search.results = { organic: [], questions: [], relatedQueries: [] };
    expect(textOf(formatSearch(search))).toContain("No result listings returned.");
    search.results.places = [
      {
        rank: 1,
        title: "Coffee shop",
        address: "Berlin",
        mapsUrl: "https://example.com/map",
        rating: 4.5,
      },
    ];
    const text = textOf(formatSearch(search));
    expect(text).toContain("Coffee shop — https://example.com/map");
    expect(text).toContain("Berlin");
    expect(text).toContain("4.5");
  });

  test("polls pending searches to completion with the official client", async () => {
    const pending = {
      ...completed(),
      status: "pending",
      results: undefined,
      pollUrl: "/v1/searches/test_search?thumbnails=false",
      retryAfterMs: 1,
    };
    const { client, requests } = await connect((url) =>
      Response.json(url.pathname === "/v1/search" ? pending : completed()),
    );
    const result = await client.callTool({
      name: "quarry_search",
      arguments: { query: "coffee", mode: "async" },
    });
    expect(textOf(result)).toContain("completed");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.pathname).toBe("/v1/searches/test_search");
    expect(requests[1]!.searchParams.get("thumbnails")).toBe("false");
  });

  test("get_search retrieves pending status without starting a new search", async () => {
    const { client, requests } = await connect(() =>
      Response.json({
        ...completed(),
        status: "pending",
        results: undefined,
        pollUrl: "/v1/searches/test_search",
        retryAfterMs: 3000,
      }),
    );
    const result = await client.callTool({
      name: "quarry_get_search",
      arguments: { id: "test_search" },
    });
    expect(textOf(result)).toContain("pending");
    expect(textOf(result)).toContain("retryAfterMs: 3000");
    expect(requests[0]!.pathname).toBe("/v1/searches/test_search");
    expect(requests).toHaveLength(1);
  });

  test("account returns actual plan limits and usage", async () => {
    const account = {
      keyId: "test",
      name: "Test",
      admin: false,
      plan: { monthlyQuota: 123, ratePerMinute: 7 },
      usage: { month: "2026-10", used: 3, remaining: 120 },
    };
    const { client, requests } = await connect(() => Response.json(account));
    const result = await client.callTool({ name: "quarry_account", arguments: {} });
    expect(result.structuredContent).toEqual(account);
    expect(textOf(result)).toContain("120 remaining");
    expect(requests[0]!.pathname).toBe("/v1/account");
  });

  test.each(["RATE_LIMITED", "QUOTA_EXCEEDED", "UNAUTHORIZED", "INVALID_CURSOR"] as const)(
    "maps %s to an MCP tool error",
    async (code) => {
      const { client } = await connect(() =>
        Response.json(
          { error: { code, message: "Upstream failure", retryable: code === "RATE_LIMITED" } },
          { status: 429 },
        ),
      );
      const result = await client.callTool({
        name: "quarry_search",
        arguments: { query: "coffee" },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(textOf(result));
      expect(payload.code).toBe(code);
      expect(payload.message).toBe("Upstream failure");
      expect(payload.retryable).toBe(code === "RATE_LIMITED");
      expect(payload.hint).toBeTruthy();
      if (code === "QUOTA_EXCEEDED") expect(payload.hint).toContain("Upgrade");
    },
  );

  test("redacts API keys and hides unexpected exception text", () => {
    expect(
      textOf(
        toolError(
          new QuarryError({ code: "NETWORK_ERROR", message: "test-secret", retryable: true }),
          "test-secret",
        ),
      ),
    ).not.toContain("test-secret");
    expect(textOf(toolError(new Error("test-secret")))).not.toContain("test-secret");
  });

  test("bounds summaries and structured text while preserving URLs and cursors", () => {
    const search = completed();
    search.results!.organic = Array.from({ length: 30 }, (_, i) => ({
      rank: i + 1,
      title: "Title",
      url: `https://example.com/${"a".repeat(1200)}`,
      snippet: "a".repeat(5000),
    }));
    const result = formatSearch(search);
    const structured = result.structuredContent as unknown as V1Search;
    expect(structured.results!.organic).toHaveLength(20);
    expect(structured.results!.organic[0]!.snippet!.length).toBeLessThan(850);
    expect(structured.results!.organic[0]!.url).toBe(search.results!.organic[0]!.url);
    expect(textOf(result)).not.toContain("6. Title");
  });

  test("requires a nonblank API key and supports a custom base URL", () => {
    expect(() => clientFromEnv({})).toThrow("QUARRY_API_KEY is required");
    expect(() => clientFromEnv({ QUARRY_API_KEY: "  " })).toThrow("QUARRY_API_KEY is required");
    expect(
      clientFromEnv({ QUARRY_API_KEY: "fake", QUARRY_BASE_URL: "http://localhost:9999" }).baseUrl,
    ).toBe("http://localhost:9999");
  });

  test("built Node executable answers stdio tools/list and calls a loopback stub", async () => {
    const build = Bun.spawn(["bun", "run", "build"], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await build.exited).toBe(0);
    const seen: string[] = [];
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.url);
        expect(request.headers.get("Authorization")).toBe("Bearer local-test-key");
        return Response.json(completed());
      },
    });
    cleanups.push(() => stub.stop(true));
    const transport = new StdioClientTransport({
      command: "node",
      args: [`${import.meta.dir}/../dist/index.js`],
      env: { QUARRY_API_KEY: "local-test-key", QUARRY_BASE_URL: `http://127.0.0.1:${stub.port}` },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(3);
    expect(seen).toHaveLength(0);
    const result = await client.callTool({ name: "quarry_search", arguments: { query: "coffee" } });
    expect(textOf(result)).toContain("Coffee guide");
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).searchParams.get("thumbnails")).toBe("false");
  }, 15000);

  test("built executable reports a missing API key without protocol output", async () => {
    const proc = Bun.spawn(["node", `${import.meta.dir}/../dist/index.js`], {
      env: { ...process.env, QUARRY_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("QUARRY_API_KEY is required");
    expect(await new Response(proc.stdout).text()).toBe("");
  });
});
