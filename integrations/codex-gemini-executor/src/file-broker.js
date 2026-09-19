import { createHash, randomUUID } from "node:crypto";
import {
  appendFile as defaultAppendFile,
  mkdir as defaultMkdir,
  open as defaultOpen,
  readFile as defaultReadFile,
  readdir as defaultReaddir,
  realpath as defaultRealpath,
  lstat as defaultLstat,
  unlink as defaultUnlink,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import { join, win32 } from "node:path";
import { TextDecoder } from "node:util";

import {
  authorizePath,
  isContainedPath,
  isDeniedEntryName,
  isSha256,
  JobScopeError,
  normalizeFileStats,
  fileIdentity as identityFromStats,
  normalizeToolPath,
} from "./job-scope.js";

export const FILE_BROKER_LIMITS = Object.freeze({
  maxFileBytes: 1 * 1024 * 1024,
  maxReadBytes: 8 * 1024 * 1024,
  maxChangedFiles: 16,
  maxBackupBytes: 32 * 1024 * 1024,
  maxListPage: 200,
  maxListedEntries: 2_000,
  maxSearchFiles: 500,
  maxSearchMatches: 100,
  maxSnippetBytes: 200,
});

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

export class FileBrokerError extends Error {
  constructor(code, reason, metadata = {}) {
    super("Gemini filesystem broker failure");
    this.name = "FileBrokerError";
    this.code = code;
    this.details = { reason };
    Object.assign(this, metadata);
  }
}

function fail(code, reason, metadata) {
  throw new FileBrokerError(code, reason, metadata);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fsApi(fs = {}) {
  return {
    appendFilePath: fs.appendFilePath ?? defaultAppendFile,
    lstatPath: async (path) => normalizeFileStats(await (fs.lstatPath ?? defaultLstat)(path, { bigint: true })),
    mkdirPath: fs.mkdirPath ?? defaultMkdir,
    openPath: fs.openPath ?? defaultOpen,
    readFilePath: fs.readFilePath ?? defaultReadFile,
    readdirPath: fs.readdirPath ?? defaultReaddir,
    realpathPath: fs.realpathPath ?? defaultRealpath,
    writeFilePath: fs.writeFilePath ?? defaultWriteFile,
    unlinkPath: fs.unlinkPath ?? defaultUnlink,
    now: fs.now ?? Date.now,
  };
}

async function writeBufferFully(handle, buffer, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = position === null
      ? await handle.write(buffer.subarray(offset))
      : await handle.write(buffer, offset, buffer.length - offset, position + offset);
    const bytesWritten = Number.isInteger(result)
      ? result
      : (Number.isInteger(result?.bytesWritten) ? result.bytesWritten : null);
    if (bytesWritten === null || bytesWritten <= 0 || bytesWritten > buffer.length - offset) {
      throw new FileBrokerError("recovery_required", "short_write");
    }
    offset += bytesWritten;
  }
}

function isRegularFile(stats) {
  return typeof stats?.isFile === "function" && stats.isFile() && stats.nlink === 1;
}

async function readRecoveryHandleBytes(api, handle, path) {
  const before = await handleStats(api, handle, path);
  if (!isRegularFile(before) || !Number.isSafeInteger(before.size) || before.size < 0
    || before.size > FILE_BROKER_LIMITS.maxFileBytes) {
    fail("recovery_required", "recovery_target_invalid");
  }
  const bytes = Buffer.allocUnsafe(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    const bytesRead = Number.isInteger(result?.bytesRead) ? result.bytesRead : result;
    if (!Number.isInteger(bytesRead) || bytesRead <= 0) fail("recovery_required", "recovery_read_incomplete");
    offset += bytesRead;
  }
  const sentinel = Buffer.allocUnsafe(1);
  const growth = await handle.read(sentinel, 0, 1, before.size);
  const growthBytes = Number.isInteger(growth?.bytesRead) ? growth.bytesRead : growth;
  const after = await handleStats(api, handle, path);
  if (growthBytes > 0 || !identityEqual(identityFromStats(before), identityFromStats(after)) || after.size !== before.size) {
    fail("file_conflict", "recovery_target_changed");
  }
  return { bytes, stats: after };
}

async function openRecoveryFile(api, path, flags = "r") {
  let handle;
  try { handle = await api.openPath(path, flags); } catch { fail("recovery_required", "recovery_file_unavailable"); }
  try {
    return { handle, value: await readRecoveryHandleBytes(api, handle, path) };
  } catch (error) {
    try { await handle.close(); } catch { /* no additional action */ }
    throw error;
  }
}

async function safeRecoveryTarget(api, workspace, relativePath) {
  const normalized = normalizeToolPath(relativePath);
  let canonicalWorkspace;
  try { canonicalWorkspace = await api.realpathPath(workspace); } catch { fail("recovery_required", "recovery_workspace_unavailable"); }
  const workspaceStats = await api.lstatPath(canonicalWorkspace).catch(() => null);
  if (typeof workspaceStats?.isDirectory !== "function" || !workspaceStats.isDirectory() || workspaceStats.isSymbolicLink?.()) {
    fail("recovery_required", "recovery_workspace_invalid");
  }
  let lexical = canonicalWorkspace;
  const parts = normalized.split("\\");
  for (let index = 0; index < parts.length; index += 1) {
    lexical = win32.join(lexical, parts[index]);
    let stats;
    try { stats = await api.lstatPath(lexical); } catch { fail("recovery_required", "recovery_target_unavailable"); }
    if (stats.isSymbolicLink?.() || (index < parts.length - 1 && !stats.isDirectory?.())) {
      fail("recovery_required", "recovery_reparse_point");
    }
  }
  let canonical;
  try { canonical = await api.realpathPath(lexical); } catch { fail("recovery_required", "recovery_target_unavailable"); }
  if (!isContainedPath(canonicalWorkspace, canonical)) fail("recovery_required", "recovery_target_outside_workspace");
  const stats = await api.lstatPath(canonical).catch(() => null);
  if (!isRegularFile(stats)) fail("recovery_required", "recovery_target_invalid");
  return { workspace, relativePath: normalized, absolutePath: canonical, identity: identityFromStats(stats) };
}

async function confirmRecoveryTargetIdentity(api, target, handle) {
  let handleStats;
  try {
    handleStats = typeof handle.stat === "function"
      ? normalizeFileStats(await handle.stat({ bigint: true }))
      : await api.lstatPath(target.absolutePath);
  } catch {
    fail("file_conflict", "recovery_target_changed");
  }
  if (!isRegularFile(handleStats) || !identityEqual(identityFromStats(handleStats), target.identity)) {
    fail("file_conflict", "recovery_target_changed");
  }
  let current;
  try {
    current = await safeRecoveryTarget(api, target.workspace, target.relativePath);
  } catch (error) {
    if (error instanceof FileBrokerError
      && !["recovery_workspace_unavailable", "recovery_workspace_invalid"].includes(error.details?.reason)) {
      fail("file_conflict", "recovery_target_changed");
    }
    throw error;
  }
  if (!identityEqual(current.identity, target.identity)) fail("file_conflict", "recovery_target_changed");
  return handleStats;
}

async function storeRecoveryBackup(api, backupDirectory, bytes) {
  const ref = sha256(bytes);
  const path = join(backupDirectory, `${ref}.bin`);
  try {
    const handle = await api.openPath(path, "wx", 0o600);
    try {
      await writeBufferFully(handle, bytes, 0);
      if (typeof handle.sync === "function") await handle.sync();
    } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") fail("recovery_required", "recovery_backup_failed");
  }
  const existing = await api.readFilePath(path).catch(() => null);
  const existingBytes = Buffer.isBuffer(existing) ? existing : Buffer.from(existing ?? []);
  if (existingBytes.length !== bytes.length || sha256(existingBytes) !== ref) fail("recovery_required", "recovery_backup_invalid");
  return ref;
}

function identityEqual(left, right) {
  return left?.dev != null && left?.ino != null
    && left.dev === right?.dev && left.ino === right?.ino && left.nlink === right?.nlink;
}

async function handleStats(api, handle, path) {
  return typeof handle.stat === "function"
    ? normalizeFileStats(await handle.stat({ bigint: true })) : api.lstatPath(path);
}

function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�$/u, "");
}

function newlineKind(text) {
  const crlf = (text.match(/\r\n/gu) ?? []).length;
  const bareLf = (text.replaceAll("\r\n", "").match(/\n/gu) ?? []).length;
  const bareCr = (text.replaceAll("\r\n", "").match(/\r/gu) ?? []).length;
  if (crlf > 0 && bareLf === 0 && bareCr === 0) return "crlf";
  if (crlf === 0 && bareLf > 0 && bareCr === 0) return "lf";
  if (crlf === 0 && bareLf === 0 && bareCr > 0) return "cr";
  if (crlf === 0 && bareLf === 0 && bareCr === 0) return "none";
  return "mixed";
}

function decodeText(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > FILE_BROKER_LIMITS.maxFileBytes) fail("limit_exceeded", "file_too_large");
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const payload = bom ? bytes.subarray(3) : bytes;
  let text;
  try { text = TEXT_DECODER.decode(payload); } catch { fail("unsupported_file", "invalid_utf8"); }
  if (text.includes("\u0000") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    fail("unsupported_file", "binary_content");
  }
  return { text, bom, newline: newlineKind(text), bytes };
}

function encodeText(text, bom) {
  if (typeof text !== "string" || text.includes("\u0000")) fail("unsupported_file", "invalid_text");
  const body = Buffer.from(text, "utf8");
  const output = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  if (output.length > FILE_BROKER_LIMITS.maxFileBytes) fail("limit_exceeded", "file_too_large");
  return output;
}

function assertObjectArgs(args, allowed, required = []) {
  if (!isRecord(args)) fail("invalid_request", "tool_arguments_object_required");
  for (const key of Object.keys(args)) if (!allowed.has(key)) fail("invalid_request", "tool_argument_unsupported");
  for (const key of required) if (!Object.hasOwn(args, key)) fail("invalid_request", "tool_argument_missing");
}

function assertText(value, maxBytes = 2 * 1024 * 1024) {
  if (typeof value !== "string" || byteLength(value) > maxBytes || value.includes("\u0000")) {
    fail("invalid_request", "tool_text_invalid");
  }
}

function safeJobId(jobId) {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) fail("invalid_request", "invalid_job_id");
  return jobId;
}

function errorWithMeta(error, code, reason, metadata = {}) {
  if (error instanceof FileBrokerError) return error;
  if (error instanceof JobScopeError) {
    return new FileBrokerError(error.code, error.details?.reason ?? reason, metadata);
  }
  return new FileBrokerError(code, reason, metadata);
}

function resultFiles(changed) {
  return [...changed].sort((left, right) => left.localeCompare(right, "en"));
}

export function createFileBroker({
  grant,
  journalDirectory,
  fs = {},
  signal,
  now = () => new Date().toISOString(),
  clock = Date.now,
  limits = {},
} = {}) {
  if (!grant || typeof grant !== "object" || typeof journalDirectory !== "string" || !win32.isAbsolute(journalDirectory)) {
    throw new TypeError("A scoped grant and absolute journal directory are required");
  }
  const api = fsApi({ ...fs, now: clock });
  const policy = { ...FILE_BROKER_LIMITS, ...limits };
  const jobId = safeJobId(grant.jobId);
  const backupDirectory = join(journalDirectory, "backups", jobId);
  const journalPath = join(journalDirectory, `${jobId}.jsonl`);
  const cursorState = new Map();
  const changedFiles = new Set();
  let sequence = 0;
  let readByteCount = 0;
  let backupBytes = 0;
  let listedEntries = 0;
  let searchFiles = 0;
  let searchMatches = 0;
  let recoveryRequired = false;
  let recoveryId = null;
  const recoveryOperationIds = new Set();
  let stopped = false;
  let finished = false;
  let writeQueue = Promise.resolve();
  const unresolvedOperations = new Map();

  const abortHandler = () => { stopped = true; };
  signal?.addEventListener?.("abort", abortHandler, { once: true });

  function checkActive() {
    if (finished || stopped || signal?.aborted) fail("cancelled", "job_cancelled");
    if (!Number.isFinite(grant.expiresAt) || clock() >= grant.expiresAt) fail("grant_expired", "grant_expired");
  }

  function countRead(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || readByteCount + bytes > policy.maxReadBytes) {
      fail("limit_exceeded", "read_budget_exceeded");
    }
    readByteCount += bytes;
  }

  function reserveRead(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || readByteCount + bytes > policy.maxReadBytes) {
      fail("limit_exceeded", "read_budget_exceeded");
    }
  }

  function markRecovery(relativePath, operation) {
    recoveryRequired = true;
    recoveryId ??= `recovery_${jobId}`;
    if (relativePath) changedFiles.add(relativePath);
    if (typeof operation?.opId === "string") recoveryOperationIds.add(operation.opId);
  }

  async function appendRecoveryMarker(operation) {
    try {
      await appendJournal({ ...operation, phase: "recovery_required" });
    } catch {
      // The in-memory summary remains authoritative when the journal itself is unavailable.
    }
  }

  function ensureChangeBudget(relativePath) {
    if (!changedFiles.has(relativePath) && changedFiles.size >= policy.maxChangedFiles) {
      fail("limit_exceeded", "changed_file_budget_exceeded");
    }
  }

  function metadata(error) {
    return {
      filesChanged: resultFiles(changedFiles),
      recoveryRequired,
      ...(recoveryId ? { recoveryId } : {}),
      ...(recoveryOperationIds.size > 0 ? { recoveryOperationIds: [...recoveryOperationIds].sort() } : {}),
      ...error,
    };
  }

  async function ensureInternalDirectories() {
    await api.mkdirPath(backupDirectory, { recursive: true });
  }

  async function appendJournal(record) {
    let journalWriteAttempted = false;
    const entry = {
      version: 1,
      jobId,
      opId: record.opId,
      sequence: ++sequence,
      relativePath: record.relativePath,
      operation: record.operation,
      beforeHash: record.beforeHash ?? null,
      intendedAfterHash: record.intendedAfterHash,
      backupRef: record.backupRef ?? null,
      phase: record.phase,
      at: now(),
    };
    const encoded = `${JSON.stringify(entry)}\n`;
    if (byteLength(encoded) > 32 * 1024) fail("protocol_error", "journal_record_too_large");
    try {
      await ensureInternalDirectories();
      let currentSize = 0;
      try {
        const current = await api.readFilePath(journalPath);
        currentSize = current.length;
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (currentSize + Buffer.byteLength(encoded) > JOURNAL_MAX_BYTES) fail("limit_exceeded", "journal_too_large");
      const handle = await api.openPath(journalPath, "a", 0o600);
      try {
        journalWriteAttempted = true;
        await writeBufferFully(handle, Buffer.from(encoded, "utf8"));
        if (typeof handle.sync === "function") await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof FileBrokerError) {
        if (journalWriteAttempted) error.journalWriteAttempted = true;
        throw error;
      }
      fail("recovery_required", "journal_write_failed", metadata(
        journalWriteAttempted ? { journalWriteAttempted: true } : {},
      ));
    }
    return entry;
  }

  async function throwPreparedFailure(error, operation, fallbackReason, fallbackCode = "recovery_required") {
    markRecovery(operation.relativePath, operation);
    if (!error?.journalWriteAttempted) await appendRecoveryMarker(operation);
    if (error instanceof FileBrokerError) {
      error.filesChanged = resultFiles(changedFiles);
      error.recoveryRequired = true;
      error.recoveryId = recoveryId;
      throw error;
    }
    fail(fallbackCode, fallbackReason, metadata());
  }

  async function storeBackup(bytes) {
    if (backupBytes + bytes.length > policy.maxBackupBytes) fail("limit_exceeded", "backup_budget_exceeded");
    const ref = sha256(bytes);
    const target = join(backupDirectory, `${ref}.bin`);
    try {
      await ensureInternalDirectories();
      const handle = await api.openPath(target, "wx", 0o600);
      try {
        await writeBufferFully(handle, bytes, 0);
        if (typeof handle.sync === "function") await handle.sync();
      } finally {
        await handle.close();
      }
      const stored = await api.readFilePath(target);
      const storedBytes = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
      if (storedBytes.length !== bytes.length || sha256(storedBytes) !== ref) {
        fail("recovery_required", "backup_verify_failed", metadata());
      }
      backupBytes += bytes.length;
    } catch (error) {
      if (error?.code === "EEXIST") {
        let existing;
        try { existing = await api.readFilePath(target); } catch { fail("recovery_required", "backup_read_failed", metadata()); }
        const existingBytes = Buffer.isBuffer(existing) ? existing : Buffer.from(existing);
        if (existingBytes.length !== bytes.length || sha256(existingBytes) !== ref) {
          fail("recovery_required", "backup_conflict", metadata());
        }
        return ref;
      }
      if (error instanceof FileBrokerError) throw error;
      fail("recovery_required", "backup_write_failed", metadata());
    }
    return ref;
  }

  async function readHandleBytes(handle, path) {
    const beforeStats = await handleStats(api, handle, path);
    if (typeof beforeStats?.isFile !== "function" || !beforeStats.isFile()) {
      fail("unsupported_file", "file_required");
    }
    if (beforeStats.nlink !== 1) fail("scope_denied", "hardlink_file");
    if (!Number.isSafeInteger(beforeStats.size) || beforeStats.size < 0) {
      fail("protocol_error", "file_size_unavailable");
    }
    const remaining = policy.maxReadBytes - readByteCount;
    if (beforeStats.size > policy.maxFileBytes || beforeStats.size > remaining) {
      fail("limit_exceeded", "read_budget_exceeded");
    }
    const bytes = Buffer.allocUnsafe(beforeStats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      const bytesRead = Number.isInteger(result?.bytesRead) ? result.bytesRead : result;
      if (!Number.isInteger(bytesRead) || bytesRead <= 0) fail("file_conflict", "file_shrank_during_read");
      offset += bytesRead;
    }
    const sentinel = Buffer.allocUnsafe(1);
    const growth = await handle.read(sentinel, 0, 1, beforeStats.size);
    const growthBytes = Number.isInteger(growth?.bytesRead) ? growth.bytesRead : growth;
    if (growthBytes > 0) fail("file_conflict", "file_grew_during_read");
    const afterStats = await handleStats(api, handle, path);
    if (!identityEqual(identityFromStats(beforeStats), identityFromStats(afterStats))
      || afterStats.size !== beforeStats.size) {
      fail("file_conflict", "file_changed_during_read");
    }
    countRead(bytes.length);
    return { bytes, stats: afterStats };
  }

  async function readBytes(path) {
    let handle;
    try { handle = await api.openPath(path, "r"); } catch { fail("operation_denied", "file_read_failed"); }
    try {
      return (await readHandleBytes(handle, path)).bytes;
    } catch (error) {
      if (error instanceof FileBrokerError) throw error;
      fail("operation_denied", "file_read_failed");
    } finally {
      try { await handle.close(); } catch { /* read failure is already reported */ }
    }
  }

  async function authorize(operation, path) {
    try {
      return await authorizePath(grant, { operation, path }, api);
    } catch (error) {
      if (error?.code) throw error;
      fail("protocol_error", "path_authorization_failed");
    }
  }

  async function readTextAt(authorized, { allowSearchTruncation = false } = {}) {
    try {
      const bytes = await readBytes(authorized.absolutePath);
      return decodeText(bytes);
    } catch (error) {
      if (allowSearchTruncation && error?.code === "limit_exceeded") return null;
      throw error;
    }
  }

  async function listFiles(args) {
    assertObjectArgs(args, new Set(["path", "cursor"]), ["path"]);
    if (typeof args.path !== "string") fail("invalid_request", "path_invalid");
    const path = normalizeToolPath(args.path);
    if (args.cursor !== undefined && (typeof args.cursor !== "string" || byteLength(args.cursor) > 512)) {
      fail("invalid_request", "cursor_invalid");
    }
    const authorized = await authorize("list_files", path);
    const entries = [];
    let offset = 0;
    if (args.cursor !== undefined) {
      const state = cursorState.get(args.cursor);
      if (!state || state.grantId !== grant.grantId || state.path !== authorized.relativePath) fail("invalid_request", "cursor_invalid");
      offset = state.offset;
    }
    let directoryEntries;
    try { directoryEntries = await api.readdirPath(authorized.absolutePath, { withFileTypes: true }); }
    catch { fail("operation_denied", "directory_read_failed"); }
    const sorted = directoryEntries
      .filter((entry) => !isDeniedEntryName(entry?.name))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    if (offset > sorted.length) fail("invalid_request", "cursor_invalid");
    let index = offset;
    let truncated = false;
    for (; index < sorted.length && entries.length < policy.maxListPage; index += 1) {
      const entry = sorted[index];
      const childPath = win32.relative(grant.workspace, join(authorized.absolutePath, entry.name));
      if (listedEntries >= policy.maxListedEntries) { truncated = true; break; }
      try {
        const childAuth = await authorize("search_text", childPath);
        entries.push(childAuth.relativePath);
        listedEntries += 1;
      } catch (error) {
        if (!["scope_denied", "operation_denied"].includes(error?.code)) throw error;
      }
    }
    const hasMore = index < sorted.length || truncated;
    let nextCursor;
    if (hasMore) {
      nextCursor = randomUUID().replaceAll("-", "");
      cursorState.set(nextCursor, { grantId: grant.grantId, path: authorized.relativePath, offset: index });
    }
    if (args.cursor) cursorState.delete(args.cursor);
    return { entries, ...(nextCursor ? { nextCursor } : {}), truncated: hasMore };
  }

  async function searchText(args) {
    assertObjectArgs(args, new Set(["path", "query"]), ["path", "query"]);
    if (typeof args.path !== "string" || typeof args.query !== "string"
      || args.query.length === 0 || byteLength(args.query) > 256) fail("invalid_request", "search_query_invalid");
    const root = await authorize("search_text", normalizeToolPath(args.path));
    const matches = [];
    let truncated = false;
    async function visit(authorized) {
      if (truncated) return;
      if (authorized.kind === "file") {
        if (searchFiles >= policy.maxSearchFiles) { truncated = true; return; }
        searchFiles += 1;
        const decoded = await readTextAt(authorized, { allowSearchTruncation: true });
        if (!decoded) { truncated = true; return; }
        let start = 0;
        while (true) {
          const found = decoded.text.indexOf(args.query, start);
          if (found < 0) break;
          if (searchMatches >= policy.maxSearchMatches) { truncated = true; return; }
          const line = decoded.text.slice(0, found).split("\n").length;
          const lineStart = decoded.text.lastIndexOf("\n", found - 1) + 1;
          const lineEnd = decoded.text.indexOf("\n", found);
          const rawSnippet = decoded.text.slice(lineStart, lineEnd < 0 ? decoded.text.length : lineEnd);
          matches.push({ path: authorized.relativePath, line, snippet: utf8Prefix(rawSnippet, policy.maxSnippetBytes) });
          searchMatches += 1;
          start = found + Math.max(args.query.length, 1);
        }
        return;
      }
      let children;
      try { children = await api.readdirPath(authorized.absolutePath, { withFileTypes: true }); }
      catch { fail("operation_denied", "directory_read_failed"); }
      for (const entry of children.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        if (isDeniedEntryName(entry?.name)) continue;
        const childPath = win32.relative(grant.workspace, join(authorized.absolutePath, entry.name));
        try {
          const child = await authorize("search_text", childPath);
          await visit(child);
        } catch (error) {
          if (!["scope_denied", "operation_denied"].includes(error?.code)) throw error;
        }
        if (truncated) return;
      }
    }
    await visit(root);
    return { matches, truncated };
  }

  async function readText(args) {
    assertObjectArgs(args, new Set(["path"]), ["path"]);
    if (typeof args.path !== "string") fail("invalid_request", "path_invalid");
    const authorized = await authorize("read_text", normalizeToolPath(args.path));
    const decoded = await readTextAt(authorized);
    return {
      text: decoded.text,
      sha256: sha256(decoded.bytes),
      encoding: "utf-8",
      bom: decoded.bom,
      newline: decoded.newline,
    };
  }

  async function confirmHandleIdentity(handle, authorized) {
    const stats = await handleStats(api, handle, authorized.absolutePath);
    const identity = identityFromStats(stats);
    if (stats.nlink !== 1 || !identityEqual(identity, authorized.identity)) {
      fail("file_conflict", "file_identity_changed");
    }
    let pathStats;
    try { pathStats = await api.lstatPath(authorized.absolutePath); } catch { fail("file_conflict", "file_missing"); }
    if (pathStats.nlink !== 1 || !identityEqual(identityFromStats(pathStats), identity)) {
      fail("file_conflict", "file_identity_changed");
    }
    return stats;
  }

  async function writeHandle(handle, authorized, expectedBeforeHash, bytes) {
    const latest = await authorize("replace_text", authorized.relativePath);
    if (latest.absolutePath.toLowerCase() !== authorized.absolutePath.toLowerCase()) {
      fail("file_conflict", "file_identity_changed");
    }
    const current = await readHandleBytes(handle, authorized.absolutePath);
    await confirmHandleIdentity(handle, authorized);
    if (sha256(current.bytes) !== expectedBeforeHash) fail("file_conflict", "expected_hash_mismatch");
    checkActive();
    await writeBufferFully(handle, bytes, 0);
    await handle.truncate(bytes.length);
    if (typeof handle.sync === "function") await handle.sync();
    checkActive();
    const after = await readHandleBytes(handle, authorized.absolutePath);
    await confirmHandleIdentity(handle, authorized);
    if (!after.bytes.equals(bytes)) fail("recovery_required", "after_write_hash_mismatch");
    return sha256(after.bytes);
  }

  async function replaceText(args) {
    assertObjectArgs(args, new Set(["path", "expected_sha256", "old_text", "new_text"]),
      ["path", "expected_sha256", "old_text", "new_text"]);
    if (typeof args.path !== "string" || typeof args.old_text !== "string" || typeof args.new_text !== "string") {
      fail("invalid_request", "replace_arguments_invalid");
    }
    assertText(args.old_text);
    assertText(args.new_text);
    if (args.old_text.length === 0) fail("invalid_request", "old_text_empty");
    const authorized = await authorize("replace_text", normalizeToolPath(args.path));
    ensureChangeBudget(authorized.relativePath);
    if (!isSha256(args.expected_sha256)) fail("invalid_request", "expected_sha256_invalid");
    let handle;
    try {
      try { handle = await api.openPath(authorized.absolutePath, "r+"); } catch { fail("file_conflict", "file_open_failed"); }
      const initial = await readHandleBytes(handle, authorized.absolutePath);
      await confirmHandleIdentity(handle, authorized);
      const beforeBytes = initial.bytes;
      if (sha256(beforeBytes) !== args.expected_sha256) fail("file_conflict", "expected_hash_mismatch");
      const decoded = decodeText(beforeBytes);
      const first = decoded.text.indexOf(args.old_text);
      if (first < 0 || decoded.text.indexOf(args.old_text, first + args.old_text.length) >= 0) {
        fail("invalid_request", "old_text_not_unique");
      }
      const afterBytes = encodeText(`${decoded.text.slice(0, first)}${args.new_text}${decoded.text.slice(first + args.old_text.length)}`, decoded.bom);
      // The same handle is reread immediately before and after writing. Reserve both
      // reads before creating any backup or prepared journal record so budget failure
      // cannot happen after the target has changed.
      reserveRead(beforeBytes.length + afterBytes.length);
      const opId = randomUUID();
      const intendedAfterHash = sha256(afterBytes);
      const backupRef = await storeBackup(beforeBytes);
      const operation = { opId, relativePath: authorized.relativePath, operation: "replace_text",
        beforeHash: args.expected_sha256, intendedAfterHash, backupRef };
      try {
        await appendJournal({ ...operation, phase: "prepared" });
      } catch (error) {
        if (error?.journalWriteAttempted) await throwPreparedFailure(error, operation, "replace_write_failed");
        throw error;
      }
      unresolvedOperations.set(opId, operation);
      changedFiles.add(authorized.relativePath);
      try {
        checkActive();
        const afterHash = await writeHandle(handle, authorized, args.expected_sha256, afterBytes);
        await appendJournal({ opId, relativePath: authorized.relativePath, operation: "replace_text",
          beforeHash: args.expected_sha256, intendedAfterHash: afterHash, backupRef, phase: "applied" });
        unresolvedOperations.delete(opId);
        return { sha256: afterHash, bytes: afterBytes.length };
      } catch (error) {
        await throwPreparedFailure(error, operation, "replace_write_failed");
      }
    } catch (error) {
      if (error instanceof FileBrokerError) {
        throw error;
      }
      fail("recovery_required", "replace_write_failed", metadata());
    } finally {
      try { await handle?.close(); } catch { /* retain recovery marker */ }
    }
  }

  async function createText(args) {
    assertObjectArgs(args, new Set(["path", "text"]), ["path", "text"]);
    if (typeof args.path !== "string") fail("invalid_request", "path_invalid");
    assertText(args.text, policy.maxFileBytes);
    const path = normalizeToolPath(args.path);
    const authorized = await authorize("create_text", path);
    if (authorized.exists) fail("operation_denied", "create_target_exists");
    ensureChangeBudget(authorized.relativePath);
    const bytes = encodeText(args.text, false);
    reserveRead(bytes.length);
    if (bytes.length + backupBytes > policy.maxBackupBytes) fail("limit_exceeded", "backup_budget_exceeded");
    const opId = randomUUID();
    const afterHash = sha256(bytes);
    const operation = { opId, relativePath: authorized.relativePath, operation: "create_text",
      beforeHash: null, intendedAfterHash: afterHash, backupRef: null };
    try {
      await appendJournal({ ...operation, phase: "prepared" });
    } catch (error) {
      if (error?.journalWriteAttempted) await throwPreparedFailure(error, operation, "create_write_failed");
      throw error;
    }
    unresolvedOperations.set(opId, operation);
    changedFiles.add(authorized.relativePath);
    let handle;
    try {
      checkActive();
      handle = await api.openPath(authorized.absolutePath, "wx+", 0o600);
      const openedStats = await handleStats(api, handle, authorized.absolutePath);
      if (openedStats.nlink !== 1) fail("scope_denied", "hardlink_file");
      await writeBufferFully(handle, bytes, 0);
      await handle.truncate(bytes.length);
      if (typeof handle.sync === "function") await handle.sync();
      checkActive();
      const writtenBuffer = (await readHandleBytes(handle, authorized.absolutePath)).bytes;
      if (!writtenBuffer.equals(bytes)) fail("recovery_required", "create_hash_mismatch");
      await appendJournal({ opId, relativePath: authorized.relativePath, operation: "create_text",
        beforeHash: null, intendedAfterHash: afterHash, backupRef: null, phase: "applied" });
      unresolvedOperations.delete(opId);
      return { sha256: afterHash, bytes: bytes.length };
    } catch (error) {
      await throwPreparedFailure(
        error,
        operation,
        error?.code === "EEXIST" ? "create_target_exists" : "create_write_failed",
        error?.code === "EEXIST" ? "operation_denied" : "recovery_required",
      );
    } finally {
      try { await handle?.close(); } catch { /* retain recovery marker */ }
    }
  }

  function enqueueWrite(operation) {
    const next = writeQueue.then(operation);
    writeQueue = next.catch(() => {});
    return next;
  }

  async function dispatch(name, args) {
    checkActive();
    const operations = { list_files: listFiles, read_text: readText, search_text: searchText,
      replace_text: replaceText, create_text: createText };
    const operation = operations[name];
    if (!operation) fail("operation_denied", "unknown_tool");
    try {
      if (name === "replace_text" || name === "create_text") {
        return await enqueueWrite(async () => {
          checkActive();
          if (recoveryRequired) fail("recovery_required", "recovery_pending", metadata());
          return operation(args);
        });
      }
      return await operation(args);
    } catch (error) {
      if (error instanceof FileBrokerError) throw error;
      throw errorWithMeta(error, "protocol_error", "broker_operation_failed", metadata());
    }
  }

  async function finish() {
    if (finished) return recoverySummary();
    await writeQueue;
    for (const operation of unresolvedOperations.values()) markRecovery(operation.relativePath, operation);
    finished = true;
    signal?.removeEventListener?.("abort", abortHandler);
    return recoverySummary();
  }

  function recoverySummary() {
    if (unresolvedOperations.size > 0) {
      for (const operation of unresolvedOperations.values()) markRecovery(operation.relativePath, operation);
    }
    return {
      filesChanged: resultFiles(changedFiles),
      recoveryRequired,
      ...(recoveryId ? { recoveryId } : {}),
      ...(recoveryOperationIds.size > 0 ? { recoveryOperationIds: [...recoveryOperationIds].sort() } : {}),
    };
  }

  return Object.freeze({ dispatch, finish, recoverySummary });
}

async function readJournal({ journalDirectory, jobId, fs = {} }) {
  const api = fsApi(fs);
  safeJobId(jobId);
  const path = join(journalDirectory, `${jobId}.jsonl`);
  let raw;
  try {
    raw = await api.readFilePath(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail("operation_denied", "journal_absent");
    fail("recovery_required", "journal_unavailable");
  }
  if (Buffer.byteLength(raw, "utf8") > JOURNAL_MAX_BYTES) fail("recovery_required", "journal_too_large");
  const records = [];
  const lines = String(raw).split("\n");
  const lastRecordLine = lines.reduce((last, line, index) => line ? index : last, -1);
  let tailInvalid = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (!isRecord(value) || value.jobId !== jobId || !["prepared", "applied", "recovery_required"].includes(value.phase)) {
        throw new Error("journal_invalid");
      }
      records.push(value);
    } catch (error) {
      if (error instanceof FileBrokerError) throw error;
      if (index === lastRecordLine) { tailInvalid = true; break; }
      fail("recovery_required", "journal_invalid");
    }
  }
  return { api, records, tailInvalid, journalPath: path, backupDirectory: join(journalDirectory, "backups", jobId) };
}

function restorePendingPath(backupDirectory, sourceOpId) {
  if (typeof sourceOpId !== "string" || !SAFE_JOB_ID.test(sourceOpId)) fail("recovery_required", "journal_invalid");
  return join(backupDirectory, `.restore-${sourceOpId}.pending`);
}

async function prepareRestoreMarker(api, path) {
  let handle;
  try { handle = await api.openPath(path, "wx", 0o600); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stats = await api.lstatPath(path);
    if (!isRegularFile(stats) || stats.isSymbolicLink?.()) fail("recovery_required", "recovery_marker_invalid");
    handle = await api.openPath(path, "r+");
  }
  try {
    await writeBufferFully(handle, Buffer.from("pending\n"), 0);
    await handle.sync();
  } finally { await handle.close(); }
}

async function resolvedJournalOperations(records, api, backupDirectory) {
  const prepared = new Map();
  const latest = new Map();
  for (const record of records) {
    if (record.phase === "prepared") prepared.set(record.opId, record);
    latest.set(record.opId, record);
  }
  const resolved = new Set();
  const pending = new Set();
  for (const source of prepared.values()) {
    if (!isSha256(source.backupRef)) continue;
    try {
      await api.lstatPath(restorePendingPath(backupDirectory, source.opId));
      pending.add(source.opId);
    } catch (error) {
      if (error?.code !== "ENOENT") pending.add(source.opId);
    }
  }
  for (const restore of latest.values()) {
    if (restore.operation !== "recovery_restore" || restore.phase !== "applied") continue;
    const start = prepared.get(restore.opId);
    const source = prepared.get(restore.sourceOpId);
    if (!start || !source || pending.has(source.opId)
      || restore.opId === restore.sourceOpId || !isSha256(source.backupRef)) continue;
    const stableFields = ["operation", "relativePath", "beforeHash", "intendedAfterHash", "backupRef", "sourceOpId", "sourceBackupRef"];
    if (stableFields.some((field) => start[field] !== restore[field])) continue;
    if (source.relativePath !== restore.relativePath || source.backupRef !== restore.sourceBackupRef
      || source.backupRef !== restore.intendedAfterHash || source.beforeHash !== source.backupRef) continue;
    if (!Number.isSafeInteger(source.sequence) || !Number.isSafeInteger(start.sequence)
      || !Number.isSafeInteger(restore.sequence) || source.sequence >= start.sequence || start.sequence >= restore.sequence) continue;
    resolved.add(source.opId);
    // An operator-confirmed retry for this same source supersedes earlier failed
    // attempts to restore it, without resolving restores of unrelated operations.
    for (const previous of prepared.values()) {
      if (previous.operation === "recovery_restore" && previous.opId !== restore.opId
        && previous.sourceOpId === source.opId && previous.relativePath === restore.relativePath
        && previous.sourceBackupRef === restore.sourceBackupRef && previous.sequence < start.sequence) {
        resolved.add(previous.opId);
      }
    }
  }
  return { resolved, pending };
}

export async function summarizeRecoveryJournal({ journalDirectory, jobId, fs = {} } = {}) {
  if (typeof journalDirectory !== "string" || !win32.isAbsolute(journalDirectory)) {
    fail("invalid_request", "recovery_paths_invalid");
  }
  const safeId = safeJobId(jobId);
  let journal;
  try {
    journal = await readJournal({ journalDirectory, jobId: safeId, fs });
  } catch (error) {
    if (error instanceof FileBrokerError && error.details?.reason === "journal_absent") {
      return { filesChanged: [], recoveryRequired: false, journalState: "absent", journalVerified: false };
    }
    const journalState = error instanceof FileBrokerError && error.details?.reason === "journal_too_large"
      ? "oversize"
      : error instanceof FileBrokerError && error.details?.reason === "journal_invalid"
        ? "invalid"
        : "unavailable";
    return {
      filesChanged: [], recoveryRequired: true, recoveryId: `recovery_${safeId}`,
      journalState, journalVerified: false,
    };
  }
  const changedFiles = new Set();
  const operations = new Map();
  const { resolved: resolvedSources, pending } = await resolvedJournalOperations(journal.records, journal.api, journal.backupDirectory);
  for (const record of journal.records) {
    if (["replace_text", "create_text", "recovery_restore"].includes(record.operation)
      && typeof record.relativePath === "string" && byteLength(record.relativePath) <= 4_096) {
      changedFiles.add(record.relativePath);
    }
    const operation = operations.get(record.opId) ?? { unresolved: false };
    if (record.phase === "prepared" || record.phase === "recovery_required") operation.unresolved = true;
    if (record.phase === "applied") operation.unresolved = false;
    operations.set(record.opId, operation);
  }
  for (const opId of resolvedSources) {
    const operation = operations.get(opId);
    if (operation) operation.unresolved = false;
  }
  for (const opId of pending) operations.set(opId, { unresolved: true });
  const recoveryRequired = journal.tailInvalid || [...operations.values()].some((operation) => operation.unresolved);
  return {
    filesChanged: resultFiles(changedFiles),
    recoveryRequired,
    ...(recoveryRequired ? { recoveryId: `recovery_${safeId}` } : {}),
    resolvedOperationIds: [...resolvedSources].sort(),
    journalState: journal.tailInvalid ? "invalid" : "verified",
    journalVerified: !journal.tailInvalid,
  };
}

export async function previewRecovery({ journalDirectory, jobId, workspace, fs = {} } = {}) {
  if (typeof journalDirectory !== "string" || !win32.isAbsolute(journalDirectory)
    || typeof workspace !== "string" || !win32.isAbsolute(workspace)) fail("invalid_request", "recovery_paths_invalid");
  const { api, records, tailInvalid, backupDirectory } = await readJournal({ journalDirectory, jobId, fs });
  const byOp = new Map();
  const { resolved: resolvedSourceOps, pending } = await resolvedJournalOperations(records, api, backupDirectory);
  for (const record of records) {
    const current = byOp.get(record.opId) ?? { ...record, phases: [] };
    current.phases.push(record.phase);
    current.phase = record.phase;
    byOp.set(record.opId, current);
  }
  const output = [];
  for (const record of byOp.values()) {
    let currentHash = null;
    try {
      const target = await safeRecoveryTarget(api, workspace, record.relativePath);
      const opened = await openRecoveryFile(api, target.absolutePath);
      try { currentHash = sha256(opened.value.bytes); } finally { await opened.handle.close(); }
    } catch { /* an unsafe or unavailable target is reported by null hash */ }
    let backupHash = null;
    if (record.backupRef) {
      try {
        const opened = await openRecoveryFile(api, join(backupDirectory, `${record.backupRef}.bin`));
        try { backupHash = sha256(opened.value.bytes); } finally { await opened.handle.close(); }
      } catch { /* missing or invalid backup is reported by null hash */ }
    }
    const unresolved = !resolvedSourceOps.has(record.opId)
      && (pending.has(record.opId) || record.phase !== "applied" || record.phases.includes("recovery_required"));
    output.push({ relativePath: record.relativePath, operation: record.operation, beforeHash: record.beforeHash,
      intendedAfterHash: record.intendedAfterHash, backupRef: record.backupRef, currentHash, backupHash,
      phase: record.phase, unresolved,
      ...(typeof record.sourceOpId === "string" ? { sourceOpId: record.sourceOpId } : {}),
      ...(typeof record.sourceBackupRef === "string" ? { sourceBackupRef: record.sourceBackupRef } : {}),
    });
  }
  return {
    jobId,
    records: output,
    tailInvalid,
    recoveryRequired: tailInvalid || output.some((record) => record.unresolved),
  };
}

export async function applyRecovery({ journalDirectory, jobId, workspace, relativePath, backupRef, expectedCurrentHash, fs = {} } = {}) {
  if (typeof journalDirectory !== "string" || !win32.isAbsolute(journalDirectory)
    || typeof workspace !== "string" || !win32.isAbsolute(workspace)
    || typeof relativePath !== "string" || !isSha256(backupRef) || !isSha256(expectedCurrentHash)) {
    fail("invalid_request", "recovery_arguments_invalid");
  }
  const normalized = normalizeToolPath(relativePath);
  const { api, records, tailInvalid, journalPath, backupDirectory } = await readJournal({ journalDirectory, jobId, fs });
  if (tailInvalid) fail("recovery_required", "journal_tail_invalid");
  let targetRecord = [...records].reverse().find((record) => record.relativePath === normalized && record.backupRef === backupRef);
  if (!targetRecord || !targetRecord.beforeHash) fail("operation_denied", "recovery_backup_not_available");
  // A failed retry may itself have backed up the already restored bytes. Follow
  // only that same-backup chain so another retry keeps the original pending marker.
  const visited = new Set();
  while (targetRecord.operation === "recovery_restore" && targetRecord.sourceBackupRef === backupRef) {
    if (visited.has(targetRecord.opId)) fail("recovery_required", "journal_invalid");
    visited.add(targetRecord.opId);
    const source = records.find((record) => record.opId === targetRecord.sourceOpId
      && record.phase === "prepared" && record.relativePath === normalized && record.backupRef === backupRef);
    if (!source) fail("recovery_required", "journal_invalid");
    targetRecord = source;
  }
  const pendingPath = restorePendingPath(backupDirectory, targetRecord.opId);
  const target = await safeRecoveryTarget(api, workspace, normalized);
  const openedBackup = await openRecoveryFile(api, join(backupDirectory, `${backupRef}.bin`));
  let targetHandle;
  let recoveryPrepared = false;
  let writeRecoveryRecord;
  try {
    const backup = openedBackup.value.bytes;
    if (sha256(backup) !== backupRef) fail("recovery_required", "recovery_backup_invalid");
    targetHandle = await api.openPath(target.absolutePath, "r+");
    const current = await readRecoveryHandleBytes(api, targetHandle, target.absolutePath);
    await confirmRecoveryTargetIdentity(api, target, targetHandle);
    if (!identityEqual(identityFromStats(current.stats), target.identity) || sha256(current.bytes) !== expectedCurrentHash) {
      fail("file_conflict", "recovery_hash_mismatch");
    }
    const restoreBackupRef = await storeRecoveryBackup(api, backupDirectory, current.bytes);
    const opId = randomUUID();
    const sequence = Math.max(0, ...records.map((record) => Number.isSafeInteger(record.sequence) ? record.sequence : 0));
    writeRecoveryRecord = async (phase) => {
      const encoded = Buffer.from(`${JSON.stringify({
        version: 1, jobId, opId, sequence: sequence + ({ prepared: 1, applied: 2, recovery_required: 3 }[phase] ?? 3), relativePath: normalized,
        operation: "recovery_restore", beforeHash: expectedCurrentHash, intendedAfterHash: backupRef,
        backupRef: restoreBackupRef, sourceOpId: targetRecord.opId, sourceBackupRef: backupRef,
        phase, at: new Date().toISOString(),
      })}\n`, "utf8");
      const journalHandle = await api.openPath(journalPath, "a", 0o600);
      try {
        await writeBufferFully(journalHandle, encoded);
        if (typeof journalHandle.sync === "function") await journalHandle.sync();
      } finally { await journalHandle.close(); }
    };
    // This independent marker survives a journal sync failure even if appending
    // the failure record also fails. Only confirmed completion removes it.
    await prepareRestoreMarker(api, pendingPath);
    await writeRecoveryRecord("prepared");
    recoveryPrepared = true;
    const rechecked = await readRecoveryHandleBytes(api, targetHandle, target.absolutePath);
    await confirmRecoveryTargetIdentity(api, target, targetHandle);
    if (!identityEqual(identityFromStats(rechecked.stats), target.identity) || sha256(rechecked.bytes) !== expectedCurrentHash) {
      fail("file_conflict", "recovery_hash_mismatch");
    }
    await writeBufferFully(targetHandle, backup, 0);
    await targetHandle.truncate(backup.length);
    if (typeof targetHandle.sync === "function") await targetHandle.sync();
    await confirmRecoveryTargetIdentity(api, target, targetHandle);
    const after = await readRecoveryHandleBytes(api, targetHandle, target.absolutePath);
    await confirmRecoveryTargetIdentity(api, target, targetHandle);
    if (!after.bytes.equals(backup) || sha256(after.bytes) !== backupRef) fail("recovery_required", "recovery_verify_failed");
    await writeRecoveryRecord("applied");
    await api.unlinkPath(pendingPath);
    return { status: "restored", relativePath: normalized, sha256: backupRef };
  } catch (error) {
    if (recoveryPrepared && writeRecoveryRecord) {
      try { await writeRecoveryRecord("recovery_required"); } catch { /* the prepared record remains the recovery signal */ }
    }
    if (error instanceof FileBrokerError) throw error;
    fail("recovery_required", "recovery_write_failed");
  } finally {
    try { await targetHandle?.close(); } catch { /* recovery remains visible */ }
    try { await openedBackup.handle.close(); } catch { /* recovery remains visible */ }
  }
}
