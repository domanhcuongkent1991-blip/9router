import { createAppServerCompatibilityAdapter } from "./adapter.js";
import { createAppServerApprovalAdapter } from "./approvals.js";
import { APP_SERVER_REQUIRED_METHODS, AppServerCompatibilityError } from "./compatibility.js";
import { normalizeAppServerNotification } from "./events.js";
import { createStableHandshakeDriver } from "./handshake.js";
import { createAppServerJsonlClient } from "./jsonl-client.js";
import { launchAppServer, stopChildProcess } from "./process.js";
import { createAppServerSessionAdapter } from "./session.js";

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_FINAL_ANSWER_BYTES = 64 * 1024;

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function compatibilityError(stage, reason, observation) {
  return new AppServerCompatibilityError({
    stage,
    reason,
    observedVersion: observation?.version ?? "unknown",
  });
}

function boundedAppend(current, delta, sanitizeForDisplay) {
  let sanitized;
  try { sanitized = sanitizeForDisplay(`${current}${delta}`); } catch {
    throw compatibilityError("event", "sanitization_failed");
  }
  if (typeof sanitized !== "string") throw compatibilityError("event", "invalid_sanitizer_output");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length <= MAX_FINAL_ANSWER_BYTES) return bytes.toString("utf8");
  return bytes.subarray(0, MAX_FINAL_ANSWER_BYTES).toString("utf8").replace(/�$/u, "");
}

function validateQualification(qualification, observation) {
  const missingCapabilities = APP_SERVER_REQUIRED_METHODS.filter((method) => qualification?.methods?.[method] !== true);
  if (qualification?.schemaSubsetCompatible !== true || missingCapabilities.length > 0) {
    throw new AppServerCompatibilityError({
      stage: "schema",
      observedVersion: observation?.version ?? "unknown",
      schemaSubsetCompatible: qualification?.schemaSubsetCompatible === true,
      missingCapabilities,
    });
  }
}

export async function prepareAppServerRuntime({
  executablePath,
  codexHome,
  workingDirectory,
  environment,
  spawnProcess,
  observeExecutable,
  baseline,
  clientInfo,
  schemaQualification,
  loadSchemaQualification,
  fixedModel,
  fixedModelProvider,
  sanitizeForDisplay,
  onWarning = () => {},
  requestTimeoutMs = 15_000,
  approvalTimeoutMs = 120_000,
  maxStderrBytes = MAX_STDERR_BYTES,
  stopProcess = stopChildProcess,
  beforeRun = async () => {},
}) {
  let observation;
  try {
    observation = await observeExecutable();
  } catch (error) {
    throw compatibilityError("observe", "observation_failed", observation);
  }
  let qualification;
  try {
    qualification = loadSchemaQualification ? await loadSchemaQualification(observation) : schemaQualification;
    validateQualification(qualification, observation);
  } catch (error) {
    if (error instanceof AppServerCompatibilityError) throw error;
    throw compatibilityError("schema", "qualification_failed", observation);
  }

  let child;
  try {
    if (typeof observation?.executablePath !== "string") throw new Error("missing observed executable path");
    child = launchAppServer({ executablePath: observation.executablePath, codexHome, workingDirectory, environment, spawnProcess });
  } catch {
    throw compatibilityError("launch", "launch_failed", observation);
  }
  if (!child?.stdin || !child?.stdout || !child?.stderr) {
    try { await stopProcess(child); } catch { /* the original failure remains authoritative */ }
    throw compatibilityError("launch", "invalid_child_streams", observation);
  }

  const fatal = deferred();
  let fatalError;
  let active = null;
  let disposed = false;
  let stderrBytes = 0;

  function fail(error) {
    if (fatalError) return;
    fatalError = error instanceof Error ? error : compatibilityError("runtime", "unknown_failure", observation);
    fatal.resolve(fatalError);
    active?.terminal.resolve({ error: fatalError });
  }

  function onStderr(chunk) {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > maxStderrBytes) fail(compatibilityError("stderr", "stderr_too_large", observation));
  }
  function onChildError() { fail(compatibilityError("transport", "child_error", observation)); }
  function onChildExit() {
    if (!disposed && active) fail(compatibilityError("transport", "child_exited", observation));
  }
  child.stderr.on("data", onStderr);
  child.stderr.on("error", onChildError);
  child.on("error", onChildError);
  child.on("exit", onChildExit);

  let client;
  async function onNotification(message) {
    try {
      const event = normalizeAppServerNotification(message);
      if (!event) return;
      if (!active || event.threadId !== active.threadId || (active.turnId && event.turnId !== active.turnId)) {
        throw compatibilityError("event", "active_turn_mismatch", observation);
      }
      if (!active.turnId) active.turnId = event.turnId;
      if (event.type === "assistant_delta") active.answer = boundedAppend(active.answer, event.text, sanitizeForDisplay);
      await active.onEvent(event);
      if (event.type === "turn_completed") active.terminal.resolve({ event });
    } catch (error) {
      fail(error);
    }
  }
  async function onServerRequest(message) {
    try {
      if (!active?.approval) throw compatibilityError("approval", "no_active_turn", observation);
      const result = await active.approval.handle(message, {
        jobId: active.jobId,
        threadId: active.threadId,
        turnId: active.turnId,
      });
      if (result.decision === "cancel") active.terminal.resolve({ error: Object.assign(new Error("Approval cancelled"), { code: "cancelled" }) });
    } catch (error) {
      active?.terminal.resolve({ error });
    }
  }
  client = createAppServerJsonlClient({
    readable: child.stdout,
    writable: child.stdin,
    requestTimeoutMs,
    onNotification,
    onServerRequest,
    onFatal: fail,
  });

  const handshake = createStableHandshakeDriver({ client, schemaQualification: qualification });
  const compatibilityAdapter = createAppServerCompatibilityAdapter({
    baseline,
    clientInfo,
    observeExecutable: async () => observation,
    initialize: handshake.initialize,
    probeRequiredContract: handshake.probeRequiredContract,
    onWarning,
  });
  let compatibility;
  try {
    compatibility = await Promise.race([
      compatibilityAdapter.check(),
      fatal.promise.then((error) => Promise.reject(error)),
    ]);
  } catch (error) {
    client.close();
    disposed = true;
    try { await stopProcess(child); } catch { /* fail closed with compatibility error */ }
    if (error instanceof AppServerCompatibilityError) throw error;
    throw compatibilityError("handshake", "handshake_failed", observation);
  }

  const session = createAppServerSessionAdapter({ client, fixedModel, fixedModelProvider });
  let used = false;

  async function run({ request, executionWorkspace, onEvent, requestDecision, jobId = "job_runtime" }) {
    if (used || disposed || fatalError) throw compatibilityError("runtime", "runtime_unavailable", observation);
    used = true;
    await beforeRun();
    if (typeof onEvent !== "function") throw compatibilityError("runtime", "event_handler_required", observation);
    const threadPolicy = {
      cwd: executionWorkspace,
      sandbox: request.access === "workspace-write" ? "workspace-write" : "read-only",
      approvalPolicy: "on-request",
    };
    const thread = request.sessionId
      ? await session.resumeThread({ threadId: request.sessionId, ...threadPolicy })
      : await session.startThread(threadPolicy);
    const terminal = deferred();
    active = {
      jobId,
      threadId: thread.threadId,
      turnId: null,
      answer: "",
      onEvent,
      terminal,
      approval: createAppServerApprovalAdapter({
        respond: client.respond,
        requestDecision: async (prompt) => {
          await onEvent({ type: "approval_required", approval: prompt });
          if (typeof requestDecision !== "function") throw new Error("elicitation_unavailable");
          return requestDecision(prompt);
        },
        sanitizeForDisplay,
        timeoutMs: approvalTimeoutMs,
      }),
    };
    const turn = await session.startTurn({ threadId: thread.threadId, task: request.task, effort: request.effort });
    if (active.turnId !== null && active.turnId !== turn.turnId) {
      const error = compatibilityError("turn_start", "turn_start_mismatch", observation);
      fail(error);
      throw error;
    }
    active.turnId = turn.turnId;
    const outcome = await Promise.race([
      terminal.promise,
      fatal.promise.then((error) => ({ error })),
    ]);
    if (outcome.error) throw outcome.error;
    if (outcome.event.status === "cancelled") throw Object.assign(new Error("Turn cancelled"), { code: "cancelled" });
    if (outcome.event.status !== "completed") throw Object.assign(new Error("Turn failed"), { code: "protocol_error" });
    return {
      sessionId: thread.threadId,
      finalAnswer: active.answer,
      filesChanged: [],
      tests: [],
    };
  }

  async function cancel() {
    if (disposed) return;
    if (active?.threadId && active?.turnId) {
      await session.interruptTurn({ threadId: active.threadId, turnId: active.turnId });
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    client.close();
    child.stderr.off("data", onStderr);
    child.stderr.off("error", onChildError);
    child.off("error", onChildError);
    child.off("exit", onChildExit);
    await stopProcess(child);
    active = null;
  }

  return Object.freeze({ compatibility, run, cancel, dispose });
}
