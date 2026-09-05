import { posix, win32 } from "node:path";

import { AppServerCompatibilityError } from "./compatibility.js";

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const DECISIONS = Object.freeze(["accept", "decline", "cancel"]);
const MAX_IDENTIFIER_BYTES = 512;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_REASON_BYTES = 16 * 1024;
const MAX_CWD_BYTES = 4096;
const MAX_TIMEOUT_MS = 300_000;
const TIMED_OUT = Symbol("approval_timeout");

export class AppServerApprovalError extends Error {
  constructor(reason, stage, cause) {
    super("App Server approval failure");
    this.name = "AppServerApprovalError";
    this.code = "app_server_approval_error";
    this.details = { reason, stage };
    if (cause !== undefined) {
      this.details.causeType = cause instanceof Error ? cause.name : "UnknownError";
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maxBytes) {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validRequestId(value) {
  return Number.isSafeInteger(value) || boundedString(value, MAX_IDENTIFIER_BYTES);
}

function nullableString(value, maxBytes) {
  return value === undefined || value === null
    ? null
    : typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes
      ? value
      : undefined;
}

function compatibilityFailure(method, reason) {
  const safeMethod = method === COMMAND_APPROVAL || method === FILE_APPROVAL ? method : "unknown";
  throw new AppServerCompatibilityError({ stage: "approval", method: safeMethod, reason });
}

function normalizeMessage(message, activeTurn) {
  if (!isObject(message)) compatibilityFailure("unknown", "invalid_message");
  if (message.method !== COMMAND_APPROVAL && message.method !== FILE_APPROVAL) {
    compatibilityFailure("unknown", "unsupported_method");
  }
  if (!validRequestId(message.id)) compatibilityFailure(message.method, "invalid_request_id");
  if (!isObject(activeTurn)
    || !boundedString(activeTurn.jobId, MAX_IDENTIFIER_BYTES)
    || !boundedString(activeTurn.threadId, MAX_IDENTIFIER_BYTES)
    || !boundedString(activeTurn.turnId, MAX_IDENTIFIER_BYTES)) {
    compatibilityFailure(message.method, "invalid_active_turn");
  }

  const params = message.params;
  if (!isObject(params)
    || !boundedString(params.threadId, MAX_IDENTIFIER_BYTES)
    || !boundedString(params.turnId, MAX_IDENTIFIER_BYTES)
    || !boundedString(params.itemId, MAX_IDENTIFIER_BYTES)) {
    compatibilityFailure(message.method, "invalid_params");
  }
  if (params.threadId !== activeTurn.threadId || params.turnId !== activeTurn.turnId) {
    compatibilityFailure(message.method, "active_turn_mismatch");
  }

  const reason = nullableString(params.reason, MAX_REASON_BYTES);
  if (reason === undefined) compatibilityFailure(message.method, "invalid_reason");

  if (message.method === FILE_APPROVAL) {
    if (params.grantRoot !== undefined && params.grantRoot !== null) {
      compatibilityFailure(message.method, "unsupported_grant_root");
    }
    return { id: message.id, type: "file_change", params, reason };
  }

  if (params.kind !== undefined && params.kind !== null && params.kind !== "command") {
    compatibilityFailure(message.method, "unsupported_command_kind");
  }
  const command = nullableString(params.command, MAX_COMMAND_BYTES);
  const cwd = nullableString(params.cwd, MAX_CWD_BYTES);
  if (command === undefined) compatibilityFailure(message.method, "invalid_command");
  if (cwd === undefined || (cwd !== null && !win32.isAbsolute(cwd) && !posix.isAbsolute(cwd))) {
    compatibilityFailure(message.method, "invalid_cwd");
  }
  return { id: message.id, type: "command", params, command, cwd, reason };
}

export function createAppServerApprovalAdapter({
  respond,
  requestDecision,
  sanitizeForDisplay,
  timeoutMs,
}) {
  if (typeof respond !== "function"
    || typeof requestDecision !== "function"
    || typeof sanitizeForDisplay !== "function"
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AppServerApprovalError("invalid_configuration", "config");
  }

  let activeRequestId;

  async function cancelAndFail(id, reason, stage, cause) {
    try {
      await respond(id, { decision: "cancel" });
    } catch (error) {
      throw new AppServerApprovalError("cancel_response_failed", "respond", error);
    }
    throw new AppServerApprovalError(reason, stage, cause);
  }

  function createDeadline() {
    let expired = false;
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(TIMED_OUT);
      }, timeoutMs);
      timer.unref?.();
    });
    return {
      run(callback) {
        if (expired) return Promise.reject(TIMED_OUT);
        return Promise.race([Promise.resolve().then(callback), timeout]);
      },
      clear() {
        clearTimeout(timer);
      },
    };
  }

  async function sanitize(value, maxBytes, deadline) {
    const sanitized = await deadline.run(() => sanitizeForDisplay(value));
    if (sanitized === null) return null;
    if (typeof sanitized !== "string" || Buffer.byteLength(sanitized, "utf8") > maxBytes) {
      throw new TypeError("invalid sanitizer output");
    }
    return sanitized;
  }

  async function handle(message, activeTurn) {
    const normalized = normalizeMessage(message, activeTurn);
    if (activeRequestId !== undefined) {
      if (activeRequestId === normalized.id) {
        throw new AppServerApprovalError("duplicate_approval", "concurrency");
      }
      return cancelAndFail(normalized.id, "approval_in_progress", "concurrency");
    }

    activeRequestId = normalized.id;
    const deadline = createDeadline();
    try {
      let prompt;
      try {
        if (normalized.type === "command") {
          const command = await sanitize(normalized.command, MAX_COMMAND_BYTES, deadline);
          const cwd = await sanitize(normalized.cwd, MAX_CWD_BYTES, deadline);
          const reason = await sanitize(normalized.reason, MAX_REASON_BYTES, deadline);
          prompt = {
            type: "command",
            jobId: activeTurn.jobId,
            threadId: activeTurn.threadId,
            turnId: activeTurn.turnId,
            itemId: normalized.params.itemId,
            command,
            cwd,
            reason,
            decisions: [...DECISIONS],
          };
        } else {
          const reason = await sanitize(normalized.reason, MAX_REASON_BYTES, deadline);
          prompt = {
            type: "file_change",
            jobId: activeTurn.jobId,
            threadId: activeTurn.threadId,
            turnId: activeTurn.turnId,
            itemId: normalized.params.itemId,
            reason,
            decisions: [...DECISIONS],
          };
        }
      } catch (error) {
        if (error === TIMED_OUT) {
          return await cancelAndFail(normalized.id, "approval_timeout", "sanitize");
        }
        return await cancelAndFail(normalized.id, "sanitization_failed", "sanitize", error);
      }

      let decision;
      try {
        decision = await deadline.run(() => requestDecision(prompt));
      } catch (error) {
        if (error === TIMED_OUT) {
          return await cancelAndFail(normalized.id, "approval_timeout", "decision");
        }
        return await cancelAndFail(normalized.id, "decision_failed", "decision", error);
      }
      if (!DECISIONS.includes(decision)) {
        return await cancelAndFail(normalized.id, "invalid_decision", "decision");
      }

      try {
        await respond(normalized.id, { decision });
      } catch (error) {
        throw new AppServerApprovalError("response_failed", "respond", error);
      }
      return { decision };
    } finally {
      deadline.clear();
      activeRequestId = undefined;
    }
  }

  return Object.freeze({ handle });
}
