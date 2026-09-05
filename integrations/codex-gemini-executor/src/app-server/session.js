import { posix, win32 } from "node:path";

const MAX_IDENTIFIER_BYTES = 512;
const MAX_CWD_BYTES = 4096;
const MAX_TASK_BYTES = 64 * 1024;

export class AppServerSessionError extends Error {
  constructor(reason, stage, cause) {
    super("App Server session failure");
    this.name = "AppServerSessionError";
    this.code = "app_server_session_error";
    this.details = { reason, stage };
    if (cause !== undefined) this.details.causeType = cause instanceof Error ? cause.name : "UnknownError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function isBoundedString(value, maxBytes = MAX_IDENTIFIER_BYTES) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validCwd(value) {
  return isBoundedString(value, MAX_CWD_BYTES) && (win32.isAbsolute(value) || posix.isAbsolute(value));
}

function failInput(value, keys) {
  return hasExactKeys(value, keys);
}

function validThreadPolicy(value, includesThreadId) {
  const keys = includesThreadId
    ? ["threadId", "cwd", "sandbox", "approvalPolicy"]
    : ["cwd", "sandbox", "approvalPolicy"];
  return failInput(value, keys)
    && validCwd(value.cwd)
    && ["read-only", "workspace-write"].includes(value.sandbox)
    && ["on-request", "never"].includes(value.approvalPolicy)
    && (!includesThreadId || isBoundedString(value.threadId));
}

function validTurnStart(value) {
  return failInput(value, ["threadId", "task", "effort"])
    && isBoundedString(value.threadId)
    && typeof value.task === "string"
    && value.task.trim().length > 0
    && Buffer.byteLength(value.task.trim(), "utf8") <= MAX_TASK_BYTES
    && ["low", "medium", "high"].includes(value.effort);
}

function validInterrupt(value) {
  return failInput(value, ["threadId", "turnId"])
    && isBoundedString(value.threadId)
    && isBoundedString(value.turnId);
}

function threadIdFrom(response) {
  return isObject(response) && isObject(response.thread) && isBoundedString(response.thread.id)
    ? response.thread.id
    : undefined;
}

function turnFrom(response) {
  if (!isObject(response) || !isObject(response.turn) || !isBoundedString(response.turn.id)) return undefined;
  return response.turn;
}

export function createAppServerSessionAdapter({ client, fixedModel, fixedModelProvider }) {
  if (!isBoundedString(fixedModel) || !isBoundedString(fixedModelProvider) || typeof client?.request !== "function") {
    throw new AppServerSessionError("invalid_configuration", "config");
  }

  async function request(method, params, stage) {
    try {
      return await client.request(method, params);
    } catch (error) {
      throw new AppServerSessionError("request_failed", stage, error);
    }
  }

  async function startThread(value) {
    if (!validThreadPolicy(value, false)) throw new AppServerSessionError("invalid_input", "input");
    const response = await request("thread/start", {
      cwd: value.cwd,
      model: fixedModel,
      modelProvider: fixedModelProvider,
      sandbox: value.sandbox,
      approvalPolicy: value.approvalPolicy,
      ephemeral: false,
    }, "thread_start");
    const threadId = threadIdFrom(response);
    if (!threadId) throw new AppServerSessionError("invalid_thread_response", "response");
    return { threadId };
  }

  async function resumeThread(value) {
    if (!validThreadPolicy(value, true)) throw new AppServerSessionError("invalid_input", "input");
    const response = await request("thread/resume", {
      threadId: value.threadId,
      cwd: value.cwd,
      model: fixedModel,
      modelProvider: fixedModelProvider,
      sandbox: value.sandbox,
      approvalPolicy: value.approvalPolicy,
    }, "thread_resume");
    const threadId = threadIdFrom(response);
    if (!threadId) throw new AppServerSessionError("invalid_thread_response", "response");
    if (threadId !== value.threadId) throw new AppServerSessionError("thread_id_mismatch", "response");
    return { threadId };
  }

  async function startTurn(value) {
    if (!validTurnStart(value)) throw new AppServerSessionError("invalid_input", "input");
    const response = await request("turn/start", {
      threadId: value.threadId,
      input: [{ type: "text", text: value.task.trim() }],
      model: fixedModel,
      effort: value.effort,
    }, "turn_start");
    const turn = turnFrom(response);
    if (!turn || turn.status !== "inProgress") throw new AppServerSessionError("invalid_turn_response", "response");
    return { threadId: value.threadId, turnId: turn.id, status: "running" };
  }

  async function interruptTurn(value) {
    if (!validInterrupt(value)) throw new AppServerSessionError("invalid_input", "input");
    const response = await request("turn/interrupt", { threadId: value.threadId, turnId: value.turnId }, "turn_interrupt");
    if (!isObject(response)) throw new AppServerSessionError("invalid_interrupt_response", "response");
    return { threadId: value.threadId, turnId: value.turnId, status: "interrupt_requested" };
  }

  return Object.freeze({ startThread, resumeThread, startTurn, interruptTurn });
}
