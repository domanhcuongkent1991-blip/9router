#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REQUIRED_SCOPED_CANARY_CHECKS, createScopedIdentity, requireScopedQualification }
  from "./scoped-qualification.js";
import { buildRelease, collectGitProvenance, verifyRelease } from "./release.js";
import { promoteScopedQualification } from "./qualification-cli.js";

const sourceDirectory = fileURLToPath(new URL("./", import.meta.url));
const lockPath = win32.join(sourceDirectory, "..", "package-lock.json");
const scratchBase = "C:\\tmp\\CodexScratch\\";
const PRODUCTION_RUNTIME_ROOT = "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime";
const REHEARSAL_ROUTER = Object.freeze({ version: "rehearsal", buildId: "rehearsal", contractVersion: 1 });

function rehearsalRootError(reason) {
  return Object.assign(new Error(`Rehearsal scratch root rejected: ${reason}`), {
    code: "rehearsal_root_invalid", details: { reason },
  });
}

function requireScratchRoot(scratchRoot, scratchBase) {
  if (typeof scratchRoot !== "string" || !/^[A-Za-z]:[\\/]/u.test(scratchRoot)
    || typeof scratchBase !== "string" || !/^[A-Za-z]:[\\/]/u.test(scratchBase)) {
    throw rehearsalRootError("absolute_path_required");
  }
  const normalized = win32.normalize(scratchRoot).toLowerCase();
  const normalizedBase = win32.normalize(scratchBase).toLowerCase().replace(/[\\/]+$/u, "");
  if (normalizedBase.length <= 2 || !normalized.startsWith(`${normalizedBase}\\`)) throw rehearsalRootError("scratch_base_required");
  if (normalized.startsWith(win32.normalize(PRODUCTION_RUNTIME_ROOT).toLowerCase())) {
    throw rehearsalRootError("production_runtime_root_forbidden");
  }
  return win32.normalize(scratchRoot);
}

export async function runActivationRehearsal({ scratchRoot, environment = process.env, now = new Date() } = {}) {
  const root = requireScratchRoot(scratchRoot, environment.NINEROUTER_TEST_SCRATCH_ROOT ?? scratchBase);
  const scratchRuntimeRoot = win32.join(root, "runtime");
  await mkdir(scratchRuntimeRoot, { recursive: true });
  const gitInfo = await collectGitProvenance({ cwd: win32.join(sourceDirectory, "..") });
  const manifest = await buildRelease({ sourceDirectory, lockPath, gitInfo, runtimeIdentity: {
    node: { path: process.execPath, version: process.version },
    router: REHEARSAL_ROUTER,
    model: environment.NINEROUTER_GEMINI_MODEL ?? "rehearsal-model",
  }, now });
  await verifyRelease(manifest, { sourceDirectory, lockPath });
  const identity = createScopedIdentity({
    companionSha256: manifest.companionSha256,
    dependencyLockSha256: manifest.dependencyLockSha256,
    router: REHEARSAL_ROUTER,
    model: environment.NINEROUTER_GEMINI_MODEL ?? "rehearsal-model",
  });
  const evidence = {
    schemaVersion: 2,
    identity,
    approvedAt: now.toISOString(),
    checks: Object.fromEntries(REQUIRED_SCOPED_CANARY_CHECKS.map((name) => [name, true])),
    release: { releaseId: manifest.releaseId, manifestSha256: manifest.manifestSha256 },
  };
  const io = { readFile, writeFile, rename };
  await promoteScopedQualification({
    identity, evidence, runtimeRoot: scratchRuntimeRoot, buildRelease: async () => manifest, io,
    randomId: randomUUID,
  });
  const recordPath = win32.join(scratchRuntimeRoot, "qualified-scoped-combination.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  requireScopedQualification(identity, record);
  if (record.release?.releaseId !== manifest.releaseId
    || record.release?.manifestSha256 !== manifest.manifestSha256) {
    throw Object.assign(new Error("Rehearsal record lost release provenance"), {
      code: "rehearsal_record_invalid", details: { reason: "release_provenance_missing" },
    });
  }
  return {
    status: "pass",
    releaseId: manifest.releaseId,
    manifestSha256: manifest.manifestSha256,
    recordPath,
    gitDirty: manifest.provenance.gitDirty,
    router: "rehearsal-placeholder",
  };
}

function usage() {
  return "Usage: node src/rehearsal-cli.js <task-directory-under-NINEROUTER_TEST_SCRATCH_ROOT-or-C:\\tmp\\CodexScratch>";
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runActivationRehearsal({ scratchRoot: args[0] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Activation rehearsal failed: ${error?.details?.reason ?? error?.message ?? "unknown"}\n`);
    process.exitCode = 1;
  });
}
