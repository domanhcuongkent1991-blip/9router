#!/usr/bin/env node
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { readInstallationConfig, observeInstalledCombination } from "./installation.js";
import { createExecutionOwner } from "./execution-owner.js";
import { REQUIRED_CANARY_CHECKS, requireQualifiedCombination } from "./qualification.js";


export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--help" || !args.length) {
    process.stdout.write("Usage: node src/qualification-cli.js observe | promote <absolute-evidence.json>\n");
    return;
  }
  if (args[0] !== "observe" && !(args[0] === "promote" && args.length === 2 && win32.isAbsolute(args[1]))) {
    throw new Error("Invalid qualification command");
  }
  const config = readInstallationConfig();
  const runtimeRoot = config.runtimeRoot;
  if (args[0] === "observe") {
    const { identity } = await observeInstalledCombination(config);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, identity, approvedAt: null,
      checks: Object.fromEntries(REQUIRED_CANARY_CHECKS.map((name) => [name, false])),
    }, null, 2) + "\n");
    return;
  }
  const owner = await createExecutionOwner({ directory: runtimeRoot }).acquire();
  try {
    const raw = await readFile(args[1], "utf8");
    if (Buffer.byteLength(raw) > 16384) throw new Error("Evidence too large");
    const evidence = JSON.parse(raw);
    const { identity } = await observeInstalledCombination(config);
    const fingerprint = requireQualifiedCombination(identity, evidence);
    const target = win32.join(runtimeRoot, "qualified-combination.json");
    // Preserve the previous record as bytes, without reading credentials or config.
    try {
      const previous = await readFile(target);
      await writeFile(`${target}.${randomUUID()}.previous`, previous, { flag: "wx", mode: 0o600 });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const approved = { schemaVersion: 1, identity, approvedAt: evidence.approvedAt,
      checks: Object.fromEntries(REQUIRED_CANARY_CHECKS.map((name) => [name, true])) };
    await writeFile(temporary, JSON.stringify(approved), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    process.stdout.write(JSON.stringify({ status: "qualified", fingerprint }) + "\n");
  } finally { await owner.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Qualification failed: verify runtime identity, evidence and owner lock.\n");
    process.exitCode = 1;
  });
}
