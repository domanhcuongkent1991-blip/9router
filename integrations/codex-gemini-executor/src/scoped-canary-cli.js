#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { createScopedCanaryCompanion } from "./installation.js";

const FIXED_TASK = "In canary-input.txt replace exactly CANARY_9ROUTER with CANARY_9ROUTER_ACCEPTED, then create canary-output/result.txt with exactly CANARY_9ROUTER_CREATED. Do not change any other file.";
const FIXED_SCOPE = Object.freeze({
  read: Object.freeze(["canary-input.txt", "canary-output"]),
  write: Object.freeze(["canary-input.txt", "canary-output"]),
  allow_create: true,
});

function usage() {
  return "Usage: node src/scoped-canary-cli.js run --decision accept|decline|cancel\nRequires NINEROUTER_SCOPED_CANARY_WORKSPACE pointing to a prepared local fixture directory.";
}

export async function main(args = process.argv.slice(2), { environment = process.env } = {}) {
  if (args[0] === "--help" || args.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args[0] !== "run" || args.length !== 3 || args[1] !== "--decision"
    || !["accept", "decline", "cancel"].includes(args[2])) throw new Error(usage());
  const workspace = environment.NINEROUTER_SCOPED_CANARY_WORKSPACE;
  if (typeof workspace !== "string" || workspace.trim().length === 0) throw new Error("Canary workspace is not configured");
  const companion = await createScopedCanaryCompanion({ environment });
  const result = await companion.runGeminiTask({
    task: FIXED_TASK,
    workspace,
    access: "workspace-write",
    scope: FIXED_SCOPE,
    timeout_minutes: 15,
  }, { requestDecision: async () => args[2] });
  process.stdout.write(`${JSON.stringify({ ...result, task: undefined })}\n`);
  return result;
}

export { FIXED_SCOPE, FIXED_TASK };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Scoped canary failed; inspect the returned job state and recovery metadata.\n");
    process.exitCode = 1;
  });
}
