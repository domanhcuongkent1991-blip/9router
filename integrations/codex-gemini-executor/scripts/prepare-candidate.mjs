#!/usr/bin/env node
// Only creates a new candidate; never modifies active config or qualification.
import { cp, mkdir, readFile, writeFile, readdir, lstat, chmod, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRelease, verifyRelease, collectGitProvenance } from "../src/release.js";
import { createScopedIdentity, readScopedRouterIdentity, sourceDigest } from "../src/scoped-qualification.js";
import { parseMcpConfig } from "./mcp-config.mjs";

const executor = fileURLToPath(new URL("../", import.meta.url));
const model = "ag/gemini-3.8-flash";
async function rejectLinks(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("candidate_link_rejected");
  if (info.isDirectory()) for (const entry of await readdir(path)) await rejectLinks(win32.join(path, entry));
}
async function freeze(path) {
  if ((await stat(path)).isDirectory()) {
    for (const entry of await readdir(path)) await freeze(win32.join(path, entry));
  } else await chmod(path, 0o444);
}
export async function prepareCandidate({ parent, configPath }) {
  if (!/^[A-Za-z]:[\\/]/.test(parent) || win32.parse(parent).root === parent) throw new Error("candidate_parent_invalid");
  const config = parseMcpConfig(await readFile(configPath, "utf8"));
  if (config.backend !== "router-responses-v1" || config.model !== model || config.models !== model) {
    throw new Error("candidate_policy_invalid");
  }
  const router = await readScopedRouterIdentity({ baseUrl: config.routerBaseUrl });
  if (router.version !== "0.5.81") throw new Error("candidate_router_target_changed");
  await mkdir(parent, { recursive: true });
  const directory = win32.join(parent, "candidate-" + randomUUID());
  await mkdir(directory);
  const packageDirectory = win32.join(directory, "package");
  await mkdir(packageDirectory);
  const source = win32.join(executor, "src");
  // Explicit artifact boundary: .mimosa is editor state, never imported code.
  for (const name of ["src", "test", "scripts", "package.json", "package-lock.json", "node_modules"]) {
    const from = win32.join(executor, name);
    await rejectLinks(from);
    await cp(from, win32.join(packageDirectory, name), {
      recursive: true, errorOnExist: true, force: false,
      filter: (path) => !path.split(/[\\/]/).includes(".mimosa"),
    });
  }
  const sourceDirectory = win32.join(packageDirectory, "src");
  const lockPath = win32.join(packageDirectory, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key) continue;
    const actual = JSON.parse(await readFile(win32.join(packageDirectory, key, "package.json"), "utf8"));
    if (actual.version !== entry.version) throw new Error("candidate_dependency_version_mismatch");
  }
  const identity = createScopedIdentity({
    sourceDirectory, companionSha256: await sourceDigest(sourceDirectory),
    dependencyLockSha256: createHash("sha256").update(await readFile(lockPath)).digest("hex"),
    router, model, routerBaseUrl: config.routerBaseUrl, allowedModels: [model],
  });
  if (identity.companionSha256 !== await sourceDigest(source)) throw new Error("candidate_copy_drift");
  const manifest = await buildRelease({
    sourceDirectory, lockPath, runtimeIdentity: identity,
    gitInfo: await collectGitProvenance({ cwd: executor }),
  });
  await writeFile(win32.join(packageDirectory, "release-manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  await verifyRelease(manifest, { sourceDirectory, lockPath });
  // node_modules bytes are also frozen and fingerprinted; no installs/downloads.
  const dependenciesSha256 = await sourceDigest(win32.join(packageDirectory, "node_modules"));
  await freeze(packageDirectory);
  const descriptor = {
    directory, packageDirectory, identity,
    release: { releaseId: manifest.releaseId, manifestSha256: manifest.manifestSha256 },
    dependenciesSha256, configuredDesktopUnchanged: true, qualification: "not-created",
  };
  await writeFile(win32.join(directory, "candidate.json"), JSON.stringify(descriptor, null, 2), { flag: "wx" });
  return descriptor;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareCandidate({ parent: process.argv[2], configPath: process.argv[3] })
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch(() => { process.stderr.write("Candidate packaging failed; retain files and inspect the failed gate.\n"); process.exitCode = 1; });
}
