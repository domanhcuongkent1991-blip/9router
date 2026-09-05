#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createInstalledGeminiCompanion } from "./installation.js";
import { createGeminiMcpServer } from "./mcp-bridge.js";

export async function main() {
  const core = await createInstalledGeminiCompanion();
  return serveStdio(() => createGeminiMcpServer({ core }), {
    onerror: () => process.stderr.write("Gemini companion MCP transport error\n"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Gemini companion failed to start\n");
    process.exitCode = 1;
  });
}
