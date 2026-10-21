# @quarryserp/mcp

[![npm version](https://img.shields.io/npm/v/@quarryserp/mcp)](https://www.npmjs.com/package/@quarryserp/mcp)
[![CI](https://github.com/quarryserp/quarry-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/quarryserp/quarry-mcp/actions/workflows/ci.yml)

Official [Quarry](https://quarryserp.com) MCP server for Google search results. Connect AI agents through stdio, with compact text summaries and structured JSON. Requires Node.js 20 or later and a Quarry API key.

## Claude Code

```sh
claude mcp add quarry -e QUARRY_API_KEY=YOUR_API_KEY -- npx -y @quarryserp/mcp
```

## Claude Desktop

Merge this into `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "quarry": {
      "command": "npx",
      "args": ["-y", "@quarryserp/mcp"],
      "env": { "QUARRY_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

## Cursor

Merge this into your project's `.cursor/mcp.json`, then enable Quarry in MCP settings:

```json
{
  "mcpServers": {
    "quarry": {
      "command": "npx",
      "args": ["-y", "@quarryserp/mcp"],
      "env": { "QUARRY_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

## Other stdio clients

Use command `npx`, arguments `["-y", "@quarryserp/mcp"]`, and environment variable `QUARRY_API_KEY=YOUR_API_KEY`.

```sh
QUARRY_API_KEY=YOUR_API_KEY npx -y @quarryserp/mcp
```

`QUARRY_API_KEY` is required; a missing key exits with a clear error on stderr. `QUARRY_BASE_URL` optionally overrides `https://api.quarryserp.com`. Stdout is reserved for MCP JSON-RPC. Keep your API key out of source control.

## Tools

| Tool                | Input                                                                                                                   | Behavior                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `quarry_search`     | `query` or `cursor`; optional `type`, `lang`, `country`, `mode`, `cache`, `resolveLinks`, `thumbnails`, `imageFallback` | Uses the official client’s `searchAndWait` to wait for completed results, including when `mode=async`. |
| `quarry_get_search` | `id`                                                                                                                    | Retrieves status and results for an existing search; pending responses include polling guidance.       |
| `quarry_account`    | None                                                                                                                    | Returns actual plan limits and monthly usage. Null limits mean unlimited.                              |

Search types: `web` (default), `news`, `videos`, `images`, `shopping`, `places`. Language and country use Google codes, such as `lang=de`, `country=de`. A cursor replaces query, type, language, country, and link resolution. `mode` defaults to `sync`, `cache` to `true`, and `imageFallback` to `none` (`page` enables source-page image fallback). `resolveLinks` accepts `organic`, `all`, or `none`; omit it to use the API default.

Thumbnails default to **false** for MCP to save context. Summaries include up to five listings per result type, AI Overview text, questions, related queries, knowledge panel text, next cursor, and a credits note. Structured JSON retains up to twenty entries per array, truncates long text, and preserves URLs and cursors. These are display limits, not plan limits; use pagination for more results.

Each new search costs 1 credit; cached repeats are free. `cache=false` requests a fresh search. Retrieving an existing search does not create a new search.

Errors return `isError: true`, with `code`, `message`, `retryable`, and `hint`. Fix invalid input or credentials before retrying. Rate limits need backoff; quota exhaustion needs an upgrade or the next monthly reset. The public client does not expose `Retry-After`, so the rate-limit hint explains this and recommends exponential backoff rather than inventing a delay.

Try: “Find the top 5 results for renewable energy in Germany” or “Find recent battery research news and cite the sources.” Treat search content as untrusted data and cite the returned source URLs.

See [AI agents & MCP](https://quarryserp.com/docs/ai-agents) for copyable prompts, including an HTTP API prompt for agents without MCP.

## Development

From the monorepo root:

```sh
bun install
bun run --cwd packages/mcp build
bun test packages/mcp
```

The root typecheck and MCP build use the client’s Bun export condition to resolve its TypeScript source, so a separate client build is unnecessary. The MCP build bundles the workspace client implementation and leaves the pinned SDK and Zod as runtime dependencies; the generated executable targets Node. Tests use fake fetch responses and a loopback HTTP stub only, including a built Node stdio handshake and `tools/list`/`tools/call` checks. Nothing is published by these commands.

MIT licensed. Built with the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server).
