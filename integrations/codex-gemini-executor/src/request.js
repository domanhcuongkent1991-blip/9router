import { realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

const ALLOWED_KEYS = new Set(["task", "workspace", "effort", "access", "session_id", "timeout_minutes"]);
const MAX_TASK_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_SESSION_ID_BYTES = 512;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 120;

export class CompanionRequestError extends Error {
  constructor(field, reason) {
    super("Invalid Gemini companion request");
    this.name = "CompanionRequestError";
    this.code = "invalid_request";
    this.details = { field, reason };
  }
}

function fail(field, reason) {
  throw new CompanionRequestError(field, reason);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsolute(value) {
  return typeof value === "string" && (win32.isAbsolute(value) || posix.isAbsolute(value));
}

function pathStyle(value) {
  return win32.isAbsolute(value) ? win32 : posix;
}

function isContained(root, candidate) {
  const path = pathStyle(root);
  if (path !== pathStyle(candidate)) return false;
  const normalizedRoot = path === win32 ? root.toLowerCase() : root;
  const normalizedCandidate = path === win32 ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function boundedNonEmptyString(value, maxBytes) {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export async function validateGeminiRequest(request, {
  permittedWorkspaceRoots,
  realpathPath = realpath,
  statPath = stat,
} = {}) {
  if (!isObject(request)) fail("request", "invalid_type");
  const unknownKey = Object.keys(request).find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey) fail(unknownKey, "unsupported_field");
  if (!boundedNonEmptyString(request.task, MAX_TASK_BYTES)) fail("task", "invalid_or_too_large");
  if (!boundedNonEmptyString(request.workspace, MAX_PATH_BYTES) || !isAbsolute(request.workspace)) {
    fail("workspace", "absolute_path_required");
  }
  const effort = request.effort ?? "medium";
  if (!["low", "medium", "high"].includes(effort)) fail("effort", "unsupported_value");
  const access = request.access ?? "read-only";
  if (!["read-only", "workspace-write"].includes(access)) fail("access", "unsupported_value");
  if (request.session_id !== undefined && !boundedNonEmptyString(request.session_id, MAX_SESSION_ID_BYTES)) {
    fail("session_id", "invalid_or_too_large");
  }
  const timeoutMinutes = request.timeout_minutes ?? 30;
  if (!Number.isInteger(timeoutMinutes)
    || timeoutMinutes < MIN_TIMEOUT_MINUTES
    || timeoutMinutes > MAX_TIMEOUT_MINUTES) {
    fail("timeout_minutes", "outside_bounds");
  }
  if (!Array.isArray(permittedWorkspaceRoots)
    || permittedWorkspaceRoots.length === 0
    || permittedWorkspaceRoots.some((root) => !boundedNonEmptyString(root, MAX_PATH_BYTES) || !isAbsolute(root))) {
    fail("workspace", "invalid_permitted_roots");
  }

  let canonicalWorkspace;
  let canonicalRoots;
  let workspaceStats;
  try {
    [canonicalWorkspace, canonicalRoots] = await Promise.all([
      realpathPath(request.workspace),
      Promise.all(permittedWorkspaceRoots.map((root) => realpathPath(root))),
    ]);
    workspaceStats = await statPath(canonicalWorkspace);
  } catch {
    fail("workspace", "workspace_unavailable");
  }
  if (!isAbsolute(canonicalWorkspace)
    || canonicalRoots.some((root) => !isAbsolute(root))) {
    fail("workspace", "invalid_canonical_path");
  }
  if (!canonicalRoots.some((root) => isContained(root, canonicalWorkspace))) {
    fail("workspace", "outside_permitted_roots");
  }
  if (typeof workspaceStats?.isDirectory !== "function" || !workspaceStats.isDirectory()) {
    fail("workspace", "not_directory");
  }

  return Object.freeze({
    task: request.task.trim(),
    workspace: canonicalWorkspace,
    effort,
    access,
    ...(request.session_id === undefined ? {} : { sessionId: request.session_id.trim() }),
    timeoutMinutes,
  });
}
