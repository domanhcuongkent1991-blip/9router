import { createHash } from "node:crypto";
import { win32 } from "node:path";

export class AppServerExecutableError extends Error {
  constructor(reason, stage, cause) {
    super("App Server executable observation failure");
    this.name = "AppServerExecutableError";
    this.code = "app_server_executable_error";
    this.details = { reason, ...(stage ? { stage } : {}) };
    if (cause !== undefined) {
      this.details.causeType = cause instanceof Error ? cause.name : "UnknownError";
    }
  }
}

function requireAbsolutePath(value) {
  if (typeof value !== "string" || !win32.isAbsolute(value)) {
    throw new AppServerExecutableError("path_not_absolute", "validate");
  }
}

function isContained(root, candidate) {
  const relative = win32.relative(root.toLowerCase(), candidate.toLowerCase());
  return relative === ""
    || (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${win32.sep}`));
}

export async function observeConfiguredExecutable({
  executablePath,
  allowedExecutableRoot,
  realpathPath,
  statPath,
  createInputStream,
  readVersion,
}) {
  requireAbsolutePath(executablePath);
  requireAbsolutePath(allowedExecutableRoot);

  let canonicalExecutable;
  let canonicalRoot;
  try {
    [canonicalExecutable, canonicalRoot] = await Promise.all([
      realpathPath(executablePath),
      realpathPath(allowedExecutableRoot),
    ]);
  } catch (error) {
    throw new AppServerExecutableError("canonicalization_failed", "canonicalize", error);
  }
  if (!win32.isAbsolute(canonicalExecutable) || !win32.isAbsolute(canonicalRoot)) {
    throw new AppServerExecutableError("invalid_canonical_path", "canonicalize");
  }
  if (!isContained(canonicalRoot, canonicalExecutable)) {
    throw new AppServerExecutableError("path_outside_allowed_root", "canonicalize");
  }

  let stats;
  try {
    stats = await statPath(canonicalExecutable);
  } catch (error) {
    throw new AppServerExecutableError("stat_failed", "stat", error);
  }
  if (typeof stats?.isFile !== "function" || !stats.isFile()) {
    throw new AppServerExecutableError("not_a_file", "stat");
  }

  const hash = createHash("sha256");
  try {
    const stream = createInputStream(canonicalExecutable);
    for await (const chunk of stream) hash.update(chunk);
  } catch (error) {
    throw new AppServerExecutableError("hash_failed", "hash", error);
  }

  let version;
  try {
    version = await readVersion(canonicalExecutable);
  } catch (error) {
    throw new AppServerExecutableError("version_read_failed", "version", error);
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new AppServerExecutableError("invalid_version", "version");
  }
  if (Buffer.byteLength(version, "utf8") > 4096) {
    throw new AppServerExecutableError("version_too_large", "version");
  }

  return {
    executablePath: canonicalExecutable,
    version: version.trim(),
    executableSha256: hash.digest("hex"),
  };
}
