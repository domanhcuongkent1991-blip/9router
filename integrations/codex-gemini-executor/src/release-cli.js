#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRelease, collectGitProvenance, verifyRelease } from "./release.js";

const executorDirectory = fileURLToPath(new URL("../", import.meta.url));
const sourceDirectory = fileURLToPath(new URL("./", import.meta.url));
const lockPath = win32.join(executorDirectory, "package-lock.json");
const MAX_MANIFEST_BYTES = 1024 * 1024;

function usage() {
  return "Usage: node src/release-cli.js build <absolute-output.json> | verify <absolute-manifest.json>";
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--help" || args.length !== 2
    || !["build", "verify"].includes(args[0]) || !win32.isAbsolute(args[1])) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args[0] === "build") {
    const manifest = await buildRelease({
      sourceDirectory, lockPath, gitInfo: await collectGitProvenance({ cwd: executorDirectory }),
    });
    const temporary = `${args[1]}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, args[1]);
    process.stdout.write(`${JSON.stringify({
      releaseId: manifest.releaseId, manifestSha256: manifest.manifestSha256,
      fileCount: manifest.sourceManifest.length, gitDirty: manifest.provenance.gitDirty,
    })}\n`);
    return;
  }
  const raw = await readFile(args[1], "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Release manifest too large");
  const result = await verifyRelease(JSON.parse(raw), { sourceDirectory, lockPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Release operation failed: ${error?.message ?? "unknown"}\n`);
    process.exitCode = 1;
  });
}
