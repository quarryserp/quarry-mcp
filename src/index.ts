#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clientFromEnv, createServer } from "./server.js";

try {
  const server = createServer(clientFromEnv());
  await server.connect(new StdioServerTransport());
} catch {
  // Do not print arbitrary error text: upstream failures can contain secrets.
  console.error(
    process.env.QUARRY_API_KEY?.trim()
      ? "Quarry MCP failed to start. Check your configuration."
      : "QUARRY_API_KEY is required. Set it to your Quarry API key before starting the MCP server.",
  );
  process.exitCode = 1;
}
