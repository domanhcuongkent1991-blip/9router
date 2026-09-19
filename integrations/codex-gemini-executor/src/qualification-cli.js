#!/usr/bin/env node
import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readInstallationConfig, observeInstalledCombination } from "./installation.js";
import { createExecutionOwner } from "./execution-owner.js";
import {
  REQUIRED_SCOPED_BOOTSTRAP_CHECKS,
  REQUIRED_SCOPED_CANARY_CHECKS,
  SCOPED_BOOTSTRAP_PROFILE,
  ScopedQualificationError,
  createScopedIdentity,
  requireScopedBootstrap,
  requireScopedQualification,
  readScopedRouterIdentity,
  sourceDigest,
} from "./scoped-qualification.js";
import { buildRelease, collectGitProvenance } from "./release.js";


export async function promoteScopedQualification({ identity, evidence, runtimeRoot, buildRelease,
  io = { readFile, writeFile, rename }, randomId = randomUUID }) {
  const fingerprint = requireScopedQualification(identity, evidence);
  const release = evidence?.release;
  if (typeof buildRelease !== "function" || !release || typeof release !== "object"
    || typeof release.releaseId !== "string" || typeof release.manifestSha256 !== "string") {
    throw new ScopedQualificationError("release_provenance_missing");
  }
  // Rebuilding the working tree here proves the canary ran on exactly these
  // bytes: any drift since the release manifest was built blocks promotion.
  const current = await buildRelease();
  if (current.releaseId !== release.releaseId || current.manifestSha256 !== release.manifestSha256) {
    throw new ScopedQualificationError("release_manifest_mismatch");
  }
  const target = win32.join(runtimeRoot, "qualified-scoped-combination.json");
  // Preserve existing bytes before replacement. If this backup cannot be made,
  // leave the current qualification record authoritative and fail closed.
  let previous;
  try {
    previous = await io.readFile(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (previous !== undefined) {
    await io.writeFile(`${target}.${randomId()}.previous`, previous, { flag: "wx", mode: 0o600 });
  }
  const temporary = `${target}.${randomId()}.tmp`;
  const approved = { schemaVersion: 2, identity, approvedAt: evidence.approvedAt,
    checks: Object.fromEntries(REQUIRED_SCOPED_CANARY_CHECKS.map((name) => [name, true])),
    release: { releaseId: release.releaseId, manifestSha256: release.manifestSha256 } };
  await io.writeFile(temporary, JSON.stringify(approved), { flag: "wx", mode: 0o600 });
  await io.rename(temporary, target);
  return fingerprint;
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--help" || !args.length) {
    process.stdout.write("Usage: node src/qualification-cli.js observe | bootstrap <absolute-evidence.json> | promote <absolute-evidence.json>\n");
    return;
  }
  if (args[0] !== "observe" && !(["bootstrap", "promote"].includes(args[0]) && args.length === 2 && win32.isAbsolute(args[1]))) {
    throw new Error("Invalid qualification command");
  }
  const config = readInstallationConfig();
  if (args[0] === "bootstrap" && config.executionBackend !== "router-responses-v1") {
    throw new Error("Bootstrap qualification requires router-responses-v1 backend");
  }
  const runtimeRoot = config.runtimeRoot;
  if (config.executionBackend === "router-responses-v1") {
    const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
    const identity = createScopedIdentity({
      companionSha256: await sourceDigest(sourceDirectory),
      dependencyLockSha256: createHash("sha256").update(await readFile(win32.join(sourceDirectory, "..", "package-lock.json"))).digest("hex"),
      router: await readScopedRouterIdentity({ baseUrl: config.routerBaseUrl }),
      model: config.fixedModel,
    });
    if (args[0] === "observe") {
      process.stdout.write(JSON.stringify({ schemaVersion: 2, identity, approvedAt: null,
        checks: Object.fromEntries(REQUIRED_SCOPED_CANARY_CHECKS.map((name) => [name, false])),
      }, null, 2) + "\n");
      return;
    }
    if (args[0] === "bootstrap") {
      const owner = await createExecutionOwner({ directory: runtimeRoot }).acquire();
      try {
        const raw = await readFile(args[1], "utf8");
        if (Buffer.byteLength(raw) > 16_384) throw new Error("Evidence too large");
        const evidence = JSON.parse(raw);
        const fingerprint = requireScopedBootstrap(identity, evidence);
        const target = win32.join(runtimeRoot, "qualified-scoped-bootstrap.json");
        try {
          const previous = await readFile(target);
          await writeFile(`${target}.${randomUUID()}.previous`, previous, { flag: "wx", mode: 0o600 });
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        const temporary = `${target}.${randomUUID()}.tmp`;
        const approved = { schemaVersion: 2, mode: "bootstrap", identity, approvedAt: evidence.approvedAt,
          checks: Object.fromEntries(REQUIRED_SCOPED_BOOTSTRAP_CHECKS.map((name) => [name, true])),
          bootstrap: SCOPED_BOOTSTRAP_PROFILE };
        await writeFile(temporary, JSON.stringify(approved), { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
        process.stdout.write(JSON.stringify({ status: "bootstrap-qualified", fingerprint }) + "\n");
      } finally { await owner.release(); }
      return;
    }
    const owner = await createExecutionOwner({ directory: runtimeRoot }).acquire();
    try {
      const raw = await readFile(args[1], "utf8");
      if (Buffer.byteLength(raw) > 16384) throw new Error("Evidence too large");
      const evidence = JSON.parse(raw);
      const fingerprint = await promoteScopedQualification({ identity, evidence, runtimeRoot,
        buildRelease: async () => buildRelease({
          sourceDirectory,
          lockPath: win32.join(sourceDirectory, "..", "package-lock.json"),
          gitInfo: await collectGitProvenance({ cwd: win32.join(sourceDirectory, "..") }),
        }),
      });
      process.stdout.write(JSON.stringify({ status: "qualified", fingerprint }) + "\n");
    } finally { await owner.release(); }
    return;
  }
  if (args[0] === "observe") {
    const { REQUIRED_CANARY_CHECKS } = await import("./qualification.js");
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
    const { REQUIRED_CANARY_CHECKS, requireQualifiedCombination } = await import("./qualification.js");
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
