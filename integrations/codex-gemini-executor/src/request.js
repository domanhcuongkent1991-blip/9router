import { lstat, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { resolveScope } from "./job-scope.js";

const ALLOWED_KEYS = new Set(["task", "workspace", "model", "effort", "access", "session_id", "timeout_minutes", "scope"]);
const MAX_TASK_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_SESSION_ID_BYTES = 512;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 120;
const SCOPED_MAX_TIMEOUT_MINUTES = 30;

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

export function isSafeModelIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,256}$/u.test(value);
}

function validModelPolicy(defaultModel, allowedModels) {
  return isSafeModelIdentifier(defaultModel)
    && Array.isArray(allowedModels)
    && allowedModels.length > 0
    && allowedModels.length <= 64
    && allowedModels.every(isSafeModelIdentifier)
    && new Set(allowedModels).size === allowedModels.length
    && allowedModels.includes(defaultModel);
}

export async function validateGeminiRequest(request, {
  permittedWorkspaceRoots,
  installationPolicy = {},
  defaultModel = "gemini-fixed",
  allowedModels = [defaultModel],
  realpathPath = realpath,
  statPath = stat,
  lstatPath = lstat,
} = {}) {
  if (!isObject(request)) fail("request", "invalid_type");
  const unknownKey = Object.keys(request).find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey) fail(unknownKey, "unsupported_field");
  if (!boundedNonEmptyString(request.task, MAX_TASK_BYTES)) fail("task", "invalid_or_too_large");
  if (!validModelPolicy(defaultModel, allowedModels)) fail("model", "invalid_allowed_models");
  const model = request.model ?? defaultModel;
  if (!isSafeModelIdentifier(model) || !allowedModels.includes(model)) fail("model", "not_allowed");
  if (installationPolicy.requireFixedModel === true && model !== installationPolicy.runtimeModel) fail("model", "not_allowed");
  if (!boundedNonEmptyString(request.workspace, MAX_PATH_BYTES) || !isAbsolute(request.workspace)) {
    fail("workspace", "absolute_path_required");
  }
  const effort = request.effort ?? "medium";
  if (!["low", "medium", "high"].includes(effort)) fail("effort", "unsupported_value");
  const access = request.access ?? "read-only";
  if (!["read-only", "workspace-write", "scoped-edit"].includes(access)) fail("access", "unsupported_value");
  // `workspace-write` is the public API spelling. Internally it is always
  // reduced to the scoped broker profile; legacy unrestricted writes are not
  // supported by this companion.
  const scoped = access === "scoped-edit"
    || request.scope !== undefined
    || (access === "workspace-write" && installationPolicy.requireScopedProfile === true);
  const scopedAccess = scoped && access === "workspace-write" ? "scoped-edit" : access;
  if (installationPolicy.rejectScopedProfile === true && scoped) {
    fail(request.scope === undefined ? "access" : "scope", "scoped_profile_required");
  }
  if (installationPolicy.requireScopedProfile === true && !scoped) fail("scope", "scoped_scope_required");
  if (scoped && request.scope === undefined) fail("scope", "scope_required");
  if (scoped && !["read-only", "scoped-edit"].includes(scopedAccess)) fail("access", "legacy_write_not_allowed");
  if (scoped && request.session_id !== undefined) fail("session_id", "scoped_resume_not_supported");
  if (request.session_id !== undefined && !boundedNonEmptyString(request.session_id, MAX_SESSION_ID_BYTES)) {
    fail("session_id", "invalid_or_too_large");
  }
  const timeoutMinutes = request.timeout_minutes ?? (scoped ? 15 : 30);
  if (!Number.isInteger(timeoutMinutes)
    || timeoutMinutes < MIN_TIMEOUT_MINUTES
    || timeoutMinutes > (scoped ? SCOPED_MAX_TIMEOUT_MINUTES : MAX_TIMEOUT_MINUTES)) {
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
  let rawWorkspaceStats;
  try {
    [canonicalWorkspace, canonicalRoots, rawWorkspaceStats] = await Promise.all([
      realpathPath(request.workspace),
      Promise.all(permittedWorkspaceRoots.map((root) => realpathPath(root))),
      scoped ? lstatPath(request.workspace) : Promise.resolve(undefined),
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
  if (scoped && typeof rawWorkspaceStats?.isSymbolicLink === "function" && rawWorkspaceStats.isSymbolicLink()) {
    fail("workspace", "reparse_point");
  }

  if (scoped) {
    const resolvedScope = await resolveScope({
      task: request.task.trim(),
      workspace: canonicalWorkspace,
      access: scopedAccess,
      scope: request.scope,
    }, {
      ...installationPolicy,
      permittedWorkspaceRoots: canonicalRoots,
    }, { realpathPath, statPath, lstatPath });
    return Object.freeze({
      task: request.task.trim(),
      workspace: canonicalWorkspace,
      effort,
      access: scopedAccess,
      ...(access === "workspace-write" ? { publicAccess: "workspace-write" } : {}),
      timeoutMinutes,
      scoped: true,
      scope: Object.freeze({
        read: Object.freeze(resolvedScope.read.map((entry) => entry.relativePath)),
        write: Object.freeze(resolvedScope.write.map((entry) => entry.relativePath)),
        allow_create: resolvedScope.allowCreate,
      }),
      resolvedScope,
      // The direct backend binds one configured model. Accepting a caller-supplied
      // alternate model here would create a policy/runtime mismatch.
      model,
      runtimeFingerprint: typeof installationPolicy.runtimeFingerprint === "string"
        ? installationPolicy.runtimeFingerprint : "router-responses-v1",
      runtimeModel: typeof installationPolicy.runtimeModel === "string" ? installationPolicy.runtimeModel : model,
    });
  }

  return Object.freeze({
    task: request.task.trim(),
    workspace: canonicalWorkspace,
    effort,
    access,
    model,
    ...(request.session_id === undefined ? {} : { sessionId: request.session_id.trim() }),
    timeoutMinutes,
  });
}
