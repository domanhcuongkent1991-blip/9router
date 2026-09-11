export const PUBLIC_ERROR_CATEGORIES = Object.freeze([
  "router_unavailable", "model_unavailable", "provider_auth_failed", "quota_exceeded", "rate_limited",
  "timeout", "cancelled", "app_server_incompatible", "workspace_dirty", "workspace_locked",
  "approval_required", "invalid_request", "protocol_error",
]);
export const PUBLIC_ERROR_SOURCES = Object.freeze([
  "codex_account", "mcp_execution", "router", "provider", "model", "unknown",
]);
export const PUBLIC_ERROR_CODES = Object.freeze([
  "account_usage_limit", "mcp_timeout", "timeout", "router_unavailable", "router_connect_failed",
  "router_transport_failed", "provider_auth_failed", "provider_quota_exceeded", "provider_rate_limit",
  "model_unavailable", "model_not_found", "router_unavailable", "model_unavailable", "provider_auth_failed",
  "provider_quota_exceeded", "cancelled", "app_server_incompatible", "workspace_dirty", "workspace_locked",
  "approval_required", "invalid_request", "app_server_schema_error", "app_server_protocol_error",
  "qualification_record_missing", "runtime_changed_during_setup", "persistence_failed",
  "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
  "serverOverloaded", "cyberPolicy", "misalignmentPolicyViolation", "internalServerError", "unauthorized",
  "badRequest", "threadRollbackFailed", "sandboxError", "other", "httpConnectionFailed",
  "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
]);
export const PUBLIC_ERROR_STAGES = Object.freeze([
  "approval", "canonicalize", "config", "event", "handshake", "initialize", "input", "launch", "observe",
  "probe", "qualification", "response", "router", "runtime", "schema", "schema_generation", "stat", "stderr",
  "stop", "thread_start", "thread_resume", "turn_start", "turn_interrupt", "transport", "validate", "version",
]);
export const PUBLIC_ERROR_REASONS = Object.freeze([
  "active_turn_mismatch", "child_error", "child_exited", "combination_not_qualified", "event_handler_required",
  "invalid_agent_message_delta", "invalid_child_streams", "invalid_completed_status", "invalid_execution_lifecycle",
  "invalid_execution_output_delta", "invalid_initialize_request", "invalid_initialize_response", "invalid_input",
  "invalid_interrupt_response", "invalid_json", "invalid_message", "invalid_method", "invalid_runtime",
  "invalid_runtime_result", "invalid_schema_structure", "invalid_schema_text", "invalid_sanitizer_output",
  "invalid_thread_response", "invalid_turn_completed", "invalid_turn_error", "invalid_turn_response", "invalid_turn_started",
  "launch_failed", "model_mismatch", "not_allowed", "not_directory", "observation_failed", "outside_permitted_roots",
  "prepared_runtime_not_compatible", "qualification_failed", "qualification_record_missing", "request_failed",
  "router_identity_unavailable", "runtime_changed_during_setup", "sanitization_failed", "schema_too_large",
  "stderr_too_large", "thread_id_mismatch", "turn_start_mismatch", "runtime_unavailable", "no_active_turn",
  "handshake_failed", "unknown_failure", "usage_limit", "version_too_large",
]);
export const PUBLIC_ERROR_FIELDS = Object.freeze(["candidate", "model", "workspace"]);

const CATEGORIES = new Set(PUBLIC_ERROR_CATEGORIES);
const SOURCES = new Set(PUBLIC_ERROR_SOURCES);
const CODES = new Set(PUBLIC_ERROR_CODES);
const STAGES = new Set(PUBLIC_ERROR_STAGES);
const REASONS = new Set(PUBLIC_ERROR_REASONS);
const FIELDS = new Set(PUBLIC_ERROR_FIELDS);
const SAFE_CODE = /^[A-Za-z0-9._:/-]{1,128}$/u;

const EXACT_REMOTE_CATEGORIES = new Map([
  ["codex_account", new Map([["account_usage_limit", "quota_exceeded"]])],
  ["mcp_execution", new Map([["timeout", "timeout"], ["mcp_timeout", "timeout"]])],
  ["router", new Map([
    ["router_unavailable", "router_unavailable"],
    ["router_connect_failed", "router_unavailable"],
    ["router_transport_failed", "router_unavailable"],
    ["serverOverloaded", "router_unavailable"],
  ])],
  ["provider", new Map([
    ["provider_auth_failed", "provider_auth_failed"],
    ["unauthorized", "provider_auth_failed"],
    ["provider_quota_exceeded", "quota_exceeded"],
    ["provider_rate_limit", "rate_limited"],
  ])],
  ["model", new Map([["model_unavailable", "model_unavailable"], ["model_not_found", "model_unavailable"]])],
]);

function ownValue(value, key) {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function known(set, value) {
  return typeof value === "string" && set.has(value) ? value : undefined;
}

function safeCode(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

function trustedStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function remoteMetadata(error) {
  const details = ownValue(error, "details");
  if (details === undefined || details === null || typeof details !== "object") return undefined;
  const rawCode = ownValue(details, "remoteCode");
  const rawSource = ownValue(details, "remoteSource");
  const rawStatus = ownValue(details, "remoteStatus");
  // Unsafe wire metadata invalidates the whole remote attribution. Safe but unknown codes are not public data.
  if ((rawCode !== undefined && safeCode(rawCode) === undefined)
    || (rawSource !== undefined && known(SOURCES, rawSource) === undefined)
    || (rawStatus !== undefined && trustedStatus(rawStatus) === undefined)) return undefined;
  const code = known(CODES, rawCode);
  const source = known(SOURCES, rawSource);
  const status = trustedStatus(rawStatus);
  return code === undefined && source === undefined && status === undefined ? undefined : { code, source, status };
}

function localMetadata(error) {
  const details = ownValue(error, "details");
  if (details === undefined || details === null || typeof details !== "object") return {};
  const stage = known(STAGES, ownValue(details, "stage"));
  const reason = known(REASONS, ownValue(details, "reason"));
  const field = known(FIELDS, ownValue(details, "field"));
  return {
    ...(stage === undefined ? {} : { stage }),
    ...(reason === undefined ? {} : { reason }),
    ...(field === undefined ? {} : { field }),
  };
}

function publicRecord(category, source, { code, status, stage, reason, field } = {}) {
  return Object.freeze({
    category: known(CATEGORIES, category) ?? "protocol_error",
    source: known(SOURCES, source) ?? "unknown",
    ...(known(CODES, code) === undefined ? {} : { code }),
    ...(trustedStatus(status) === undefined ? {} : { status }),
    ...(known(STAGES, stage) === undefined ? {} : { stage }),
    ...(known(REASONS, reason) === undefined ? {} : { reason }),
    ...(known(FIELDS, field) === undefined ? {} : { field }),
  });
}

export function normalizePublicError(value) {
  const rawCategory = ownValue(value, "category");
  // Read the one renamed legacy category without rewriting old job records or
  // carrying their former free-form error payload into the public contract.
  if (rawCategory === "provider_quota_exceeded") return publicRecord("quota_exceeded", "provider");
  const category = known(CATEGORIES, rawCategory);
  if (category === undefined) return publicRecord("protocol_error", "unknown");
  return publicRecord(category, ownValue(value, "source"), {
    code: ownValue(value, "code"),
    status: ownValue(value, "status"),
    stage: ownValue(value, "stage"),
    reason: ownValue(value, "reason"),
    field: ownValue(value, "field"),
  });
}

function classifyRemote({ source, code, status }) {
  const trusted = source ?? "unknown";
  const exact = EXACT_REMOTE_CATEGORIES.get(trusted)?.get(code);
  if (exact !== undefined) return publicRecord(exact, trusted, { code, status });

  if (code === "usageLimitExceeded" || code === "sessionBudgetExceeded") {
    return publicRecord("quota_exceeded", trusted, { code, status });
  }
  if (code === "rateLimitExceeded") {
    return publicRecord("rate_limited", trusted, { code, status });
  }
  // HTTP status informs only the layer's transient failure class; it never proves usage exhaustion.
  if (trusted === "router" && status !== undefined && status >= 500) {
    return publicRecord("router_unavailable", trusted, { code, status });
  }
  if (trusted === "provider" && [401, 403].includes(status)) {
    return publicRecord("provider_auth_failed", trusted, { code, status });
  }
  if (trusted === "provider" && status === 429) {
    return publicRecord("rate_limited", trusted, { code, status });
  }
  if (trusted === "mcp_execution" && [408, 504].includes(status)) {
    return publicRecord("timeout", trusted, { code, status });
  }
  return publicRecord("protocol_error", trusted, { code, status });
}

export function classifyCompanionError(error) {
  const remote = remoteMetadata(error);
  if (remote) return classifyRemote(remote);

  const rawCode = ownValue(error, "code");
  const code = known(CODES, rawCode);
  const local = localMetadata(error);
  switch (rawCode) {
    case "router_unavailable": return publicRecord("router_unavailable", "router", { code, ...local });
    case "model_unavailable": return publicRecord("model_unavailable", "model", { code, ...local });
    case "provider_auth_failed": return publicRecord("provider_auth_failed", "provider", { code, ...local });
    case "provider_quota_exceeded": return publicRecord("quota_exceeded", "provider", { code, ...local });
    case "timeout": return publicRecord("timeout", "mcp_execution", { code, ...local });
    case "cancelled": return publicRecord("cancelled", "unknown", { code, ...local });
    case "app_server_incompatible":
      return publicRecord("app_server_incompatible",
        local.stage === "router" || local.reason === "router_identity_unavailable" ? "router" : "unknown",
        { code, ...local });
    case "workspace_dirty":
    case "workspace_locked":
    case "approval_required":
    case "invalid_request":
      return publicRecord(code, "unknown", { code, ...local });
    case "app_server_schema_error":
    case "app_server_protocol_error":
    case "qualification_record_missing":
    case "runtime_changed_during_setup":
      return publicRecord("protocol_error", "unknown", { code, ...local });
    case "app_server_session_error":
      return publicRecord("protocol_error", "unknown", local);
    default: return publicRecord("protocol_error", "unknown");
  }
}
