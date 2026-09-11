import { AppServerCompatibilityError } from "./compatibility.js";

const MAX_IDENTIFIER_BYTES = 512;
const MAX_DELTA_BYTES = 1024 * 1024;
export const CODEX_ERROR_INFO_CODES = Object.freeze([
  "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
  "serverOverloaded", "cyberPolicy", "misalignmentPolicyViolation", "internalServerError",
  "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError", "other",
]);
export const HTTP_ERROR_INFO_CODES = Object.freeze([
  "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
export const NON_STEERABLE_TURN_KINDS = Object.freeze(["review", "compact"]);

const KNOWN_CODEX_ERROR_CODES = new Set(CODEX_ERROR_INFO_CODES);
const HTTP_ERROR_INFO_CODE_SET = new Set(HTTP_ERROR_INFO_CODES);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES;
}

function fail(method, reason) {
  throw new AppServerCompatibilityError({ stage: "event", method, reason });
}

function validTurn(params, status) {
  return isObject(params)
    && isIdentifier(params.threadId)
    && isObject(params.turn)
    && isIdentifier(params.turn.id)
    && Array.isArray(params.turn.items)
    && params.turn.status === status;
}

function normalizeTurnError(value, method) {
  if (!isObject(value) || typeof value.message !== "string") fail(method, "invalid_turn_error");
  const info = value.codexErrorInfo;
  if (info === undefined || info === null) return {};
  if (typeof info === "string") {
    if (!KNOWN_CODEX_ERROR_CODES.has(info)) fail(method, "invalid_turn_error");
    return { code: info };
  }
  if (!isObject(info)) fail(method, "invalid_turn_error");
  const keys = Object.keys(info);
  if (keys.length !== 1 || (!HTTP_ERROR_INFO_CODE_SET.has(keys[0]) && keys[0] !== "activeTurnNotSteerable")) {
    fail(method, "invalid_turn_error");
  }
  const code = keys[0];
  const details = info[code];
  if (!isObject(details)) fail(method, "invalid_turn_error");
  if (code === "activeTurnNotSteerable") {
    if (!NON_STEERABLE_TURN_KINDS.includes(details.turnKind)) fail(method, "invalid_turn_error");
    return { code };
  }
  const httpStatusCode = details.httpStatusCode;
  if (httpStatusCode !== undefined && httpStatusCode !== null
    && (!Number.isInteger(httpStatusCode) || httpStatusCode < 0 || httpStatusCode > 65_535)) {
    fail(method, "invalid_turn_error");
  }
  return {
    code,
    ...(Number.isInteger(httpStatusCode) && httpStatusCode >= 100 && httpStatusCode <= 599
      ? { status: httpStatusCode } : {}),
  };
}

export function normalizeAppServerNotification(message) {
  if (!isObject(message)) fail("unknown", "invalid_message");
  if (typeof message.method !== "string") fail("unknown", "invalid_method");

  switch (message.method) {
    case "turn/started": {
      if (!validTurn(message.params, "inProgress")) fail(message.method, "invalid_turn_started");
      return {
        type: "turn_started",
        threadId: message.params.threadId,
        turnId: message.params.turn.id,
        status: "running",
      };
    }
    case "item/agentMessage/delta": {
      const params = message.params;
      if (!isObject(params)
        || !isIdentifier(params.threadId)
        || !isIdentifier(params.turnId)
        || !isIdentifier(params.itemId)
        || typeof params.delta !== "string"
        || Buffer.byteLength(params.delta, "utf8") > MAX_DELTA_BYTES) {
        fail(message.method, "invalid_agent_message_delta");
      }
      return {
        type: "assistant_delta",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        text: params.delta,
      };
    }
    case "error": {
      const params = message.params;
      if (!isObject(params)
        || !isIdentifier(params.threadId)
        || !isIdentifier(params.turnId)
        || typeof params.willRetry !== "boolean") {
        fail(message.method, "invalid_turn_error");
      }
      return {
        type: "turn_error",
        threadId: params.threadId,
        turnId: params.turnId,
        willRetry: params.willRetry,
        error: normalizeTurnError(params.error, message.method),
      };
    }
    case "item/commandExecution/outputDelta": {
      const params = message.params;
      if (!isObject(params)
        || !isIdentifier(params.threadId)
        || !isIdentifier(params.turnId)
        || !isIdentifier(params.itemId)
        || typeof params.delta !== "string"
        || Buffer.byteLength(params.delta, "utf8") > MAX_DELTA_BYTES) {
        fail(message.method, "invalid_execution_output_delta");
      }
      return {
        type: "activity",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
      };
    }
    case "item/started":
    case "item/completed": {
      const params = message.params;
      const item = params?.item;
      if (!isObject(item) || !["commandExecution", "fileChange"].includes(item.type)) return null;
      if (!isObject(params)
        || !isIdentifier(params.threadId)
        || !isIdentifier(params.turnId)
        || !isIdentifier(item.id)) {
        fail(message.method, "invalid_execution_lifecycle");
      }
      return {
        type: message.method === "item/started" ? "execution_started" : "execution_completed",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: item.id,
      };
    }
    case "turn/completed": {
      const params = message.params;
      if (!isObject(params)
        || !isIdentifier(params.threadId)
        || !isObject(params.turn)
        || !isIdentifier(params.turn.id)
        || !Array.isArray(params.turn.items)) {
        fail(message.method, "invalid_turn_completed");
      }
      const statuses = { completed: "completed", interrupted: "cancelled", failed: "failed" };
      const status = statuses[params.turn.status];
      if (!status) fail(message.method, "invalid_completed_status");
      if (params.turn.error !== undefined && params.turn.error !== null && status !== "failed") {
        fail(message.method, "invalid_turn_error");
      }
      return {
        type: "turn_completed",
        threadId: params.threadId,
        turnId: params.turn.id,
        status,
        ...(params.turn.error === undefined || params.turn.error === null
          ? {} : { error: normalizeTurnError(params.turn.error, message.method) }),
      };
    }
    default:
      return null;
  }
}
