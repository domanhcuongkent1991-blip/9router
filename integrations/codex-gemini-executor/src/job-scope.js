import { createHash, randomUUID } from "node:crypto";
import {
  lstat as defaultLstat,
  realpath as defaultRealpath,
  readdir as defaultReaddir,
  stat as defaultStat,
} from "node:fs/promises";
import { win32 } from "node:path";

export const MAX_SCOPE_ENTRIES = 32;
export const MAX_SCOPE_PATH_BYTES = 4_096;
export const MAX_SCOPE_SUMMARY_BYTES = 16 * 1_024;
export const MAX_TOOL_PATH_BYTES = 4_096;
export const MAX_CURSOR_BYTES = 512;

const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const DENIED_SEGMENTS = new Set([
  ".git", ".codex", ".agents", ".ssh", ".aws", ".azure", ".kube", "node_modules",
]);
const SHA256 = /^[a-f0-9]{64}$/u;

export class JobScopeError extends Error {
  constructor(code, reason) {
    super("Gemini scoped job rejected");
    this.name = "JobScopeError";
    this.code = code;
    this.details = { reason };
  }
}

function fail(code, reason) {
  throw new JobScopeError(code, reason);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function lower(value) {
  return value.toLowerCase();
}

export function canonicalPathKey(value) {
  const normalized = win32.normalize(value).replace(/[\\/]+$/u, "");
  return lower(normalized.length > 2 ? normalized : normalized.slice(0, 2));
}

export function isContainedPath(root, candidate) {
  if (typeof root !== "string" || typeof candidate !== "string") return false;
  const normalizedRoot = win32.normalize(root);
  const normalizedCandidate = win32.normalize(candidate);
  if (canonicalPathKey(normalizedRoot) === canonicalPathKey(normalizedCandidate)) return true;
  const relative = win32.relative(normalizedRoot, normalizedCandidate);
  return relative !== ""
    && !win32.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith("..\\");
}

function isDriveRoot(value) {
  const normalized = win32.normalize(value);
  return /^[A-Za-z]:\\$/u.test(normalized);
}

function isForbiddenWindowsRoot(value) {
  const normalized = canonicalPathKey(value);
  const segments = normalized.split("\\");
  return ["windows", "program files", "program files (x86)", "programdata"].includes(segments[1])
    || (segments[1] === "users" && segments[3] === "appdata");
}

function isReservedOrSecretSegment(segment) {
  const name = lower(segment);
  if (DENIED_SEGMENTS.has(name) || RESERVED_SEGMENT.test(name)) return true;
  if (/[. ]$/u.test(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name === "auth.json" || name === "credentials.json") return true;
  return [".pem", ".key", ".pfx", ".p12"].some((suffix) => name.endsWith(suffix));
}

function normalizeRelativePath(value, field = "path") {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > MAX_SCOPE_PATH_BYTES) {
    fail("invalid_request", `${field}_invalid`);
  }
  if (/[\u0000-\u001f<>"|?*:]/u.test(value)
    || win32.isAbsolute(value)
    || /^[\\/]/u.test(value)
    || /^[A-Za-z]:/u.test(value)) {
    fail("invalid_request", `${field}_must_be_relative`);
  }
  const segments = value.split(/[\\/]/u);
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("invalid_request", `${field}_contains_invalid_segment`);
  }
  if (segments.some((segment) => /[. ]$/u.test(segment))) {
    fail("invalid_request", `${field}_contains_invalid_segment`);
  }
  if (segments.some(isReservedOrSecretSegment)) fail("scope_denied", "forbidden_path");
  return segments.join("\\");
}

function relativePath(workspace, absolute) {
  const value = win32.relative(workspace, absolute);
  if (!value || value === ".." || value.startsWith("..\\") || win32.isAbsolute(value)) {
    fail("scope_denied", "outside_workspace");
  }
  return value.replaceAll("/", "\\");
}

function statKind(stats) {
  if (typeof stats?.isFile === "function" && stats.isFile()) return "file";
  if (typeof stats?.isDirectory === "function" && stats.isDirectory()) return "directory";
  return null;
}

function isReparse(stats) {
  return typeof stats?.isSymbolicLink === "function" && stats.isSymbolicLink();
}

// NTFS file IDs can exceed 53 bits. Keep identity as decimal strings, while
// bounded sizes/link counts remain ordinary numbers for filesystem policy.
export function normalizeFileStats(stats) {
  const exactId = (value) => typeof value === "bigint" || Number.isSafeInteger(value)
    ? String(value) : typeof value === "string" && /^\d+$/u.test(value) ? value : null;
  return {
    ...stats,
    dev: exactId(stats?.dev),
    ino: exactId(stats?.ino),
    nlink: typeof stats?.nlink === "bigint" ? Number(stats.nlink) : stats?.nlink,
    size: typeof stats?.size === "bigint" ? Number(stats.size) : stats?.size,
    isFile: () => stats?.isFile?.() === true,
    isDirectory: () => stats?.isDirectory?.() === true,
    isSymbolicLink: () => stats?.isSymbolicLink?.() === true,
  };
}

export function fileIdentity(stats) {
  const normalized = normalizeFileStats(stats);
  return Object.freeze({
    dev: normalized.dev,
    ino: normalized.ino,
    nlink: Number.isSafeInteger(normalized.nlink) ? normalized.nlink : null,
  });
}

function fsApi(fs = {}) {
  return {
    lstatPath: async (path) => normalizeFileStats(await (fs.lstatPath ?? defaultLstat)(path, { bigint: true })),
    realpathPath: fs.realpathPath ?? defaultRealpath,
    readdirPath: fs.readdirPath ?? defaultReaddir,
    statPath: fs.statPath ?? defaultStat,
    now: fs.now ?? Date.now,
  };
}

async function safeRealpath(api, path, reason = "path_unavailable") {
  try {
    return await api.realpathPath(path);
  } catch {
    fail("invalid_request", reason);
  }
}

async function safeLstat(api, path, reason = "path_unavailable") {
  try {
    return await api.lstatPath(path);
  } catch {
    fail("invalid_request", reason);
  }
}

async function verifyRegularEntry(api, path, expectedKind) {
  const stats = await safeLstat(api, path);
  if (isReparse(stats)) fail("scope_denied", "reparse_point");
  const kind = statKind(stats);
  if (kind !== expectedKind && expectedKind !== undefined) fail("invalid_request", "unsupported_scope_entry");
  if (kind === "file" && stats.nlink !== undefined && stats.nlink !== 1) fail("scope_denied", "hardlink_file");
  return { stats, kind };
}

async function verifyNoReparseBelowWorkspace(api, workspace, candidate) {
  await verifyLexicalPath(api, workspace, candidate);
}

async function verifyLexicalPath(api, workspace, candidate, allowMissingLeaf = false) {
  const relative = win32.relative(workspace, candidate);
  const pieces = relative ? relative.split(/[\\/]/u) : [];
  let current = workspace;
  const workspaceStats = await safeLstat(api, current);
  if (isReparse(workspaceStats)) fail("scope_denied", "reparse_point");
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    current = win32.join(current, piece);
    let stats;
    try {
      stats = await api.lstatPath(current);
    } catch (error) {
      if (allowMissingLeaf && index === pieces.length - 1 && error?.code === "ENOENT") return;
      fail("scope_denied", "path_unavailable");
    }
    if (isReparse(stats)) fail("scope_denied", "reparse_point");
    if (index < pieces.length - 1 && statKind(stats) !== "directory") {
      fail("scope_denied", "path_not_directory");
    }
  }
}

function protectedRootsFrom(policy = {}) {
  return [
    ...(Array.isArray(policy.protectedRoots) ? policy.protectedRoots : []),
    policy.runtimeRoot,
    policy.backupRoot,
    policy.sourceDirectory,
    policy.nodeRuntimeRoot,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function ensureNotProtected(path, protectedRoots) {
  if (isForbiddenWindowsRoot(path)
    || protectedRoots.some((root) => isContainedPath(root, path) || isContainedPath(path, root))) {
    fail("scope_denied", "protected_path");
  }
}

async function canonicalProtectedRoots(api, policy) {
  const roots = [];
  for (const value of protectedRootsFrom(policy)) {
    try { roots.push(await api.realpathPath(value)); } catch { roots.push(win32.normalize(value)); }
  }
  return roots;
}

function validateScopeShape(scope, access) {
  if (!isRecord(scope)) fail("invalid_request", "scope_required");
  const unknown = Object.keys(scope).find((key) => !["read", "write", "allow_create"].includes(key));
  if (unknown) fail("invalid_request", "scope_unsupported_field");
  if (!Array.isArray(scope.read) || scope.read.length < 1 || scope.read.length > MAX_SCOPE_ENTRIES) {
    fail("invalid_request", "scope_read_bounds");
  }
  if (!Array.isArray(scope.write) || scope.write.length > MAX_SCOPE_ENTRIES) {
    fail("invalid_request", "scope_write_bounds");
  }
  if (scope.allow_create !== undefined && typeof scope.allow_create !== "boolean") {
    fail("invalid_request", "scope_allow_create_type");
  }
  const allowCreate = scope.allow_create ?? false;
  if (access === "read-only" && (scope.write.length > 0 || allowCreate)) {
    fail("invalid_request", "read_only_scope_write");
  }
  if (access === "scoped-edit" && scope.write.length === 0) {
    fail("invalid_request", "scoped_edit_write_required");
  }
  return allowCreate;
}

function stableScope(scope) {
  return {
    workspace: scope.workspace,
    read: scope.read.map(({ relativePath, kind }) => ({ relativePath, kind })),
    write: scope.write.map(({ relativePath, kind }) => ({ relativePath, kind })),
    allowCreate: scope.allowCreate,
    protectedRoots: scope.protectedRoots ?? [],
  };
}

export async function resolveScope(request, installationPolicy = {}, fs = {}) {
  if (!isRecord(request)) fail("invalid_request", "request_type");
  const access = request.access;
  if (access !== "read-only" && access !== "scoped-edit") fail("invalid_request", "scoped_access_required");
  const allowCreate = validateScopeShape(request.scope, access);
  const api = fsApi(fs);

  let workspace;
  try { workspace = await api.realpathPath(request.workspace); } catch { fail("invalid_request", "workspace_unavailable"); }
  if (!/^[A-Za-z]:\\/u.test(workspace) || !win32.isAbsolute(workspace) || isDriveRoot(workspace)) {
    fail("invalid_request", "workspace_invalid");
  }
  const workspaceEntry = await verifyRegularEntry(api, workspace, "directory");
  if (workspaceEntry.kind !== "directory") fail("invalid_request", "workspace_not_directory");
  await verifyNoReparseBelowWorkspace(api, workspace, workspace);

  const permitted = Array.isArray(installationPolicy.permittedWorkspaceRoots)
    ? installationPolicy.permittedWorkspaceRoots : [];
  if (permitted.length === 0) fail("invalid_request", "permitted_roots_missing");
  const canonicalRoots = [];
  for (const root of permitted) canonicalRoots.push(await safeRealpath(api, root, "workspace_unavailable"));
  if (!canonicalRoots.some((root) => isContainedPath(root, workspace))) {
    fail("invalid_request", "outside_permitted_roots");
  }

  const protectedRoots = await canonicalProtectedRoots(api, installationPolicy);
  ensureNotProtected(workspace, protectedRoots);

  const seen = new Set();
  async function resolveEntry(value, field, expected) {
    const normalized = normalizeRelativePath(value, field);
    const candidate = win32.join(workspace, normalized);
    await verifyNoReparseBelowWorkspace(api, workspace, candidate);
    let canonical;
    try { canonical = await api.realpathPath(candidate); } catch { fail("invalid_request", "scope_entry_unavailable"); }
    if (!isContainedPath(workspace, canonical)) fail("scope_denied", "outside_workspace");
    ensureNotProtected(canonical, protectedRoots);
    await verifyNoReparseBelowWorkspace(api, workspace, canonical);
    const entry = await verifyRegularEntry(api, canonical, expected);
    const canonicalRelative = relativePath(workspace, canonical);
    const key = canonicalPathKey(canonical);
    if (seen.has(`${field}:${key}`)) fail("invalid_request", "duplicate_scope_entry");
    seen.add(`${field}:${key}`);
    return Object.freeze({ absolutePath: canonical, relativePath: canonicalRelative, kind: entry.kind, identity: fileIdentity(entry.stats) });
  }

  const read = [];
  for (let index = 0; index < request.scope.read.length; index += 1) {
    read.push(await resolveEntry(request.scope.read[index], `scope.read[${index}]`));
  }
  const write = [];
  for (let index = 0; index < request.scope.write.length; index += 1) {
    write.push(await resolveEntry(request.scope.write[index], `scope.write[${index}]`));
  }

  for (const entry of write) {
    const permittedWrite = read.some((readEntry) => readEntry.kind === "directory"
      ? isContainedPath(readEntry.absolutePath, entry.absolutePath)
      : canonicalPathKey(readEntry.absolutePath) === canonicalPathKey(entry.absolutePath));
    if (!permittedWrite) fail("scope_denied", "write_outside_read_scope");
  }

  const resolved = {
    workspace,
    access,
    read,
    write,
    allowCreate,
    protectedRoots,
    summary: {
      workspace,
      read: read.map(({ relativePath, kind }) => ({ path: relativePath, kind })),
      write: write.map(({ relativePath, kind }) => ({ path: relativePath, kind })),
      allow_create: allowCreate,
    },
  };
  if (byteLength(JSON.stringify({ task: request.task ?? "", ...resolved.summary })) > MAX_SCOPE_SUMMARY_BYTES) {
    fail("invalid_request", "scope_summary_too_large");
  }
  return freezeDeep(resolved);
}

export function scopeFingerprint(scope) {
  return createHash("sha256").update(JSON.stringify(stableScope(scope))).digest("hex");
}

export function createGrant({ jobId, resolvedScope, taskHash, runtimeFingerprint, expiresAt, now = Date.now, grantId = randomUUID() }) {
  if (!isRecord(resolvedScope) || typeof jobId !== "string" || jobId.length === 0
    || typeof taskHash !== "string" || !SHA256.test(taskHash)
    || typeof runtimeFingerprint !== "string" || runtimeFingerprint.length === 0
    || !Number.isFinite(expiresAt) || expiresAt <= now()) {
    fail("invalid_request", "invalid_grant");
  }
  const grant = {
    grantId,
    jobId,
    workspace: resolvedScope.workspace,
    access: resolvedScope.access,
    read: resolvedScope.read,
    write: resolvedScope.write,
    allowCreate: resolvedScope.allowCreate,
    protectedRoots: resolvedScope.protectedRoots ?? [],
    taskHash,
    scopeHash: scopeFingerprint(resolvedScope),
    runtimeFingerprint,
    expiresAt,
    policyVersion: 1,
  };
  return freezeDeep(grant);
}

function entryAllows(entry, candidate) {
  return entry.kind === "directory"
    ? isContainedPath(entry.absolutePath, candidate)
    : canonicalPathKey(entry.absolutePath) === canonicalPathKey(candidate);
}

function operationAccess(grant, operation, candidate, existingKind) {
  const readAllowed = grant.read.some((entry) => entryAllows(entry, candidate));
  const writeAllowed = grant.write.some((entry) => entryAllows(entry, candidate));
  if (["list_files", "read_text", "search_text"].includes(operation) && !readAllowed) {
    fail("scope_denied", "path_not_readable");
  }
  if (operation === "read_text" && existingKind !== "file") fail("operation_denied", "file_required");
  if (operation === "list_files" && existingKind !== "directory") fail("operation_denied", "directory_required");
  if (operation === "replace_text" && (!writeAllowed || existingKind !== "file")) {
    fail(writeAllowed ? "operation_denied" : "scope_denied", "path_not_writable");
  }
  if (operation === "create_text" && (!grant.allowCreate || grant.access !== "scoped-edit")) {
    fail("operation_denied", "create_disabled");
  }
  if (operation === "create_text" && !writeAllowed) fail("scope_denied", "path_not_writable");
  return { readAllowed, writeAllowed };
}

export async function authorizePath(grant, { operation, path }, fs = {}) {
  const api = fsApi(fs);
  if (!grant || typeof grant !== "object" || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= api.now()) {
    fail("grant_expired", "grant_expired");
  }
  const allowedOperations = new Set(["list_files", "read_text", "search_text", "replace_text", "create_text"]);
  if (!allowedOperations.has(operation)) fail("operation_denied", "unsupported_operation");
  const normalized = normalizeRelativePath(path, "path");
  const candidate = win32.join(grant.workspace, normalized);
  if (operation === "create_text" && (!grant.allowCreate || grant.access !== "scoped-edit")) {
    fail("operation_denied", "create_disabled");
  }
  ensureNotProtected(candidate, grant.protectedRoots ?? []);
  await verifyLexicalPath(api, grant.workspace, candidate, operation === "create_text");
  let canonical;
  let stats;
  try {
    canonical = await api.realpathPath(candidate);
    stats = await api.lstatPath(canonical);
  } catch (error) {
    if (operation !== "create_text" || error?.code !== "ENOENT") fail("scope_denied", "path_unavailable");
    const parent = win32.dirname(candidate);
    try {
      canonical = await api.realpathPath(parent);
      stats = await api.lstatPath(canonical);
    } catch { fail("scope_denied", "parent_unavailable"); }
    if (statKind(stats) !== "directory" || isReparse(stats)) fail("scope_denied", "invalid_parent");
    if (!isContainedPath(grant.workspace, canonical)) fail("scope_denied", "outside_workspace");
    ensureNotProtected(canonical, grant.protectedRoots ?? []);
    const parentAllowed = grant.write.some((entry) => entry.kind === "directory" && entryAllows(entry, canonical));
    if (!parentAllowed) fail("scope_denied", "path_not_writable");
    await verifyNoReparseBelowWorkspace(api, grant.workspace, canonical);
    return Object.freeze({ absolutePath: candidate, relativePath: normalized, parentPath: canonical, exists: false, kind: "file", identity: null });
  }
  if (!isContainedPath(grant.workspace, canonical)) fail("scope_denied", "outside_workspace");
  ensureNotProtected(canonical, grant.protectedRoots ?? []);
  await verifyNoReparseBelowWorkspace(api, grant.workspace, canonical);
  if (isReparse(stats)) fail("scope_denied", "reparse_point");
  const kind = statKind(stats);
  if (!kind) fail("operation_denied", "unsupported_file_type");
  if (kind === "file" && stats.nlink !== 1) fail("scope_denied", "hardlink_file");
  const access = operationAccess(grant, operation, canonical, kind);
  if (operation === "search_text" && kind !== "file" && kind !== "directory") fail("operation_denied", "search_target_invalid");
  return Object.freeze({
    absolutePath: canonical,
    relativePath: relativePath(grant.workspace, canonical),
    exists: true,
    kind,
    identity: fileIdentity(stats),
    readAllowed: access.readAllowed,
    writeAllowed: access.writeAllowed,
  });
}

export function isDeniedEntryName(name) {
  return typeof name !== "string" || name.length === 0 || isReservedOrSecretSegment(name);
}

export function normalizeToolPath(value) {
  return normalizeRelativePath(value, "path");
}

export function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}
