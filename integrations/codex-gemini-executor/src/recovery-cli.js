#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { win32 } from "node:path";

import { applyRecovery, previewRecovery } from "./file-broker.js";
import { createExecutionOwner } from "./execution-owner.js";
import { readInstallationConfig } from "./installation.js";

function usage() {
  return "Usage: node src/recovery-cli.js preview <jobId> <absolute-workspace> | apply <jobId> <absolute-workspace> <relative-path> <backup-sha256> <current-sha256>";
}

export async function main(args = process.argv.slice(2), {
  environment = process.env,
  createOwner = createExecutionOwner,
} = {}) {
  if (args[0] === "--help" || args.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const config = readInstallationConfig(environment);
  if (config.executionBackend !== "router-responses-v1") throw new Error("Scoped Responses backend is not selected");
  const journalDirectory = win32.join(config.runtimeRoot, "scoped-jobs");
  if (args[0] === "preview" && args.length === 3) {
    const result = await previewRecovery({ journalDirectory, jobId: args[1], workspace: args[2] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (args[0] === "apply" && args.length === 6) {
    const owner = await createOwner({ directory: config.runtimeRoot }).acquire();
    try {
      const result = await applyRecovery({
        journalDirectory,
        jobId: args[1],
        workspace: args[2],
        relativePath: args[3],
        backupRef: args[4],
        expectedCurrentHash: args[5],
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result;
    } finally { await owner.release(); }
  }
  throw new Error(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Recovery failed: inspect the job journal and current hashes.\n");
    process.exitCode = 1;
  });
}
