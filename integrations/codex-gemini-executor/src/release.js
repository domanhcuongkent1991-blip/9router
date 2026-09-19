import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { sourceDigest } from "./scoped-qualification.js";

const execFile = promisify(execFileCallback);

export class ReleaseError extends Error {
  constructor(code, reason) {
    super("Release artifact rejected");
    this.name = "ReleaseError";
    this.code = code;
    this.details = { reason };
  }
}

function reject(code, reason) {
  throw new ReleaseError(code, reason);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function collectSourceFiles(directory, relative = "", files = []) {
  const entries = await readdir(join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const child = join(relative, entry.name);
    if (entry.isSymbolicLink()) reject("release_manifest_invalid", "source_link_not_allowed");
    if (entry.isDirectory()) await collectSourceFiles(directory, child, files);
    else if (entry.isFile()) files.push(child.replaceAll("\\", "/"));
  }
  return files;
}

// The manifest hash covers deterministic content only; createdAt is recorded
// but excluded so rebuilding the same tree always yields the same releaseId.
export async function buildRelease({ sourceDirectory, lockPath, gitInfo = {}, now = new Date() } = {}) {
  if (typeof sourceDirectory !== "string" || typeof lockPath !== "string") {
    reject("release_manifest_invalid", "release_inputs_invalid");
  }
  const sourceManifest = [];
  for (const path of await collectSourceFiles(sourceDirectory)) {
    sourceManifest.push({ path, sha256: await sha256File(join(sourceDirectory, path)) });
  }
  const manifest = {
    schemaVersion: 1,
    backend: "router-responses-v1",
    provenance: {
      gitHead: gitInfo.gitHead ?? null,
      gitDirty: gitInfo.gitDirty ?? null,
      uncommittedFileCount: gitInfo.uncommittedFileCount ?? null,
      nodeVersion: gitInfo.nodeVersion ?? process.version,
    },
    sourceManifest,
    dependencyLockSha256: await sha256File(lockPath),
    companionSha256: await sourceDigest(sourceDirectory),
  };
  const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return { ...manifest, createdAt: now.toISOString(), manifestSha256, releaseId: manifestSha256.slice(0, 12) };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function verifyRelease(manifest, { sourceDirectory, lockPath } = {}) {
  if (!isRecord(manifest)
    || manifest.schemaVersion !== 1
    || manifest.backend !== "router-responses-v1"
    || typeof manifest.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(manifest.manifestSha256)
    || manifest.releaseId !== manifest.manifestSha256.slice(0, 12)) {
    reject("release_manifest_invalid", "release_shape_invalid");
  }
  const rebuilt = await buildRelease({ sourceDirectory, lockPath, gitInfo: manifest.provenance ?? {} });
  const sameManifestList = JSON.stringify(rebuilt.sourceManifest) === JSON.stringify(manifest.sourceManifest ?? null);
  if (!sameManifestList) reject("release_manifest_mismatch", "source_tree_drift");
  if (rebuilt.dependencyLockSha256 !== manifest.dependencyLockSha256) {
    reject("release_manifest_mismatch", "dependency_lock_drift");
  }
  if (rebuilt.companionSha256 !== manifest.companionSha256) {
    reject("release_manifest_mismatch", "companion_source_drift");
  }
  if (rebuilt.manifestSha256 !== manifest.manifestSha256
    || rebuilt.releaseId !== manifest.releaseId) {
    reject("release_manifest_mismatch", "release_digest_drift");
  }
  return { ok: true, releaseId: rebuilt.releaseId, manifestSha256: rebuilt.manifestSha256 };
}

export async function collectGitProvenance({ runGit = execFile, cwd } = {}) {
  try {
    const { stdout: head } = await runGit("git", ["rev-parse", "HEAD"], { cwd });
    const { stdout: status } = await runGit("git", ["status", "--porcelain"], { cwd });
    const lines = status.split("\n").filter(Boolean);
    return { gitHead: head.trim(), gitDirty: lines.length > 0, uncommittedFileCount: lines.length, nodeVersion: process.version };
  } catch {
    return { gitHead: null, gitDirty: null, uncommittedFileCount: null, nodeVersion: process.version };
  }
}
