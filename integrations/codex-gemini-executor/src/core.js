import { createHash } from "node:crypto";
import { createGrant, scopeFingerprint } from "./job-scope.js";
import { classifyCompanionError, normalizePublicError } from "./error-classification.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ALLOWED_STATUSES = new Set(["starting", "running", "awaiting_approval", ...TERMINAL_STATUSES]);
const RUNTIME_RESULT_KEYS = new Set(["sessionId", "finalAnswer", "filesChanged", "tests", "recoveryRequired", "recoveryId", "recoverySources", "recoveryOperationIds"]);
const MAX_SESSION_ID_BYTES = 512;
const MAX_FINAL_ANSWER_BYTES = 64 * 1024;
const MAX_FILES_CHANGED = 1_024;
const MAX_FILE_PATH_BYTES = 4_096;
const MAX_TEST_RECORDS = 256;
const MAX_TEST_RECORD_BYTES = 16 * 1_024;
const RECOVERY_SOURCES = new Set(["journal", "cleanup", "unknown"]);
const SAFE_RECOVERY_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_RECOVERY_OPERATION_IDS = 16;
const SHA256 = /^[a-f0-9]{64}$/u;

export class CompanionJobError extends Error {
  constructor(code, reason) {
    super("Gemini companion job error");
    this.name = "CompanionJobError";
    this.code = code;
    this.details = { reason };
  }
}

class StopRequested extends Error {
  constructor(category) {
    super("Job stopped");
    this.category = category;
  }
}

class PersistenceFailure extends Error {
  constructor() {
    super("Status persistence failed");
    this.name = "PersistenceFailure";
    this.code = "protocol_error";
  }
}

function clone(value) {
  return structuredClone(value);
}

function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�$/u, "");
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function requireDependency(condition, reason) {
  if (!condition) throw new CompanionJobError("invalid_core_configuration", reason);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDeeplyFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function validScopedGrant(grant, expected) {
  try {
    return isPlainRecord(grant)
      && isDeeplyFrozen(grant)
      && grant.jobId === expected.jobId
      && grant.workspace === expected.resolvedScope.workspace
      && grant.access === expected.resolvedScope.access
      && Array.isArray(grant.read)
      && Array.isArray(grant.write)
      && grant.taskHash === expected.taskHash
      && grant.scopeHash === scopeFingerprint(expected.resolvedScope)
      && grant.runtimeFingerprint === expected.runtimeFingerprint
      && grant.expiresAt === expected.expiresAt
      && grant.policyVersion === 1;
  } catch {
    return false;
  }
}

function validRecoverySources(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= RECOVERY_SOURCES.size
    && value.every((source) => RECOVERY_SOURCES.has(source))
    && new Set(value).size === value.length;
}

function validRecoveryOperationIds(value) {
  return Array.isArray(value)
    && value.length <= MAX_RECOVERY_OPERATION_IDS
    && value.every((opId) => typeof opId === "string" && SAFE_RECOVERY_OPERATION_ID.test(opId))
    && new Set(value).size === value.length;
}

function mergeRecoverySources(...values) {
  const merged = new Set(values.flat().filter((source) => RECOVERY_SOURCES.has(source)));
  return [...merged].sort();
}

function mergeRecoveryOperationIds(...values) {
  const merged = new Set(values.flat().filter((opId) => typeof opId === "string" && SAFE_RECOVERY_OPERATION_ID.test(opId)));
  return [...merged].sort();
}

function normalizeRuntimeResult(redactor, rawResult) {
  let result;
  try {
    result = redactor.redactJson(rawResult);
  } catch {
    throw new CompanionJobError("protocol_error", "invalid_runtime_result");
  }
  if (!isPlainRecord(result)
    || Object.keys(result).some((key) => !RUNTIME_RESULT_KEYS.has(key))
    || typeof result.finalAnswer !== "string"
    || byteLength(result.finalAnswer) > MAX_FINAL_ANSWER_BYTES
    || !Array.isArray(result.filesChanged)
    || result.filesChanged.length > MAX_FILES_CHANGED
    || result.filesChanged.some((file) => typeof file !== "string" || byteLength(file) > MAX_FILE_PATH_BYTES)
    || !Array.isArray(result.tests)
    || result.tests.length > MAX_TEST_RECORDS) {
    throw new CompanionJobError("protocol_error", "invalid_runtime_result");
  }
  if (Object.hasOwn(result, "sessionId")
    && (typeof result.sessionId !== "string"
      || result.sessionId.length === 0
      || byteLength(result.sessionId) > MAX_SESSION_ID_BYTES)) {
    throw new CompanionJobError("protocol_error", "invalid_runtime_result");
  }
  if (Object.hasOwn(result, "recoveryRequired") && typeof result.recoveryRequired !== "boolean") {
    throw new CompanionJobError("protocol_error", "invalid_runtime_result");
  }
  if (Object.hasOwn(result, "recoveryId")
    && (typeof result.recoveryId !== "string" || byteLength(result.recoveryId) > MAX_SESSION_ID_BYTES)) {
    throw new CompanionJobError("protocol_error", "invalid_runtime_result");
  }
  if (Object.hasOwn(result, "recoverySources") && !validRecoverySources(result.recoverySources)) {
    throw new CompanionJobError("protocol_error", "invalid_runtime_result");
  }
  if (Object.hasOwn(result, "recoveryOperationIds") && !validRecoveryOperationIds(result.recoveryOperationIds)) {
    throw new CompanionJobError("protocol_error", "invalid_runtime_result");
  }
  for (const test of result.tests) {
    if (typeof test === "string") {
      if (byteLength(test) > MAX_TEST_RECORD_BYTES) {
        throw new CompanionJobError("protocol_error", "invalid_runtime_result");
      }
      continue;
    }
    if (!isPlainRecord(test) || byteLength(JSON.stringify(test)) > MAX_TEST_RECORD_BYTES) {
      throw new CompanionJobError("protocol_error", "invalid_runtime_result");
    }
  }
  return result;
}

export function createGeminiCompanionCore({
  validateRequest,
  compatibilityAdapter,
  workspaceLeases,
  createRuntime,
  prepareRuntime,
  workspaceManager,
  redactor,
  persistStatus = async () => {},
  generateJobId = () => `job_${crypto.randomUUID()}`,
  idleTimeoutMs = 5 * 60_000,
  millisecondsPerMinute = 60_000,
  maxAccumulatedOutputBytes = 32 * 1024,
  cleanupTimeoutMs = 5_000,
  persistenceTimeoutMs = 5_000,
  initialStatuses = [],
  createScopedGrant = createGrant,
  resolveScopedRuntimeFingerprint,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  approvalTimeoutMs = 120_000,
}) {
  requireDependency(typeof validateRequest === "function", "validate_request_required");
  const usesPreparedRuntime = typeof prepareRuntime === "function";
  requireDependency(usesPreparedRuntime || typeof compatibilityAdapter?.check === "function", "compatibility_adapter_required");
  requireDependency(typeof workspaceLeases?.acquire === "function", "workspace_leases_required");
  requireDependency(usesPreparedRuntime || typeof createRuntime === "function", "runtime_factory_required");
  requireDependency(workspaceManager === undefined || typeof workspaceManager?.prepare === "function", "workspace_manager_invalid");
  requireDependency(typeof redactor?.redactJson === "function"
    && typeof redactor?.redactError === "function"
    && typeof redactor?.sanitizeForDisplay === "function", "redactor_required");
  requireDependency(typeof persistStatus === "function", "persistence_required");
  requireDependency(typeof generateJobId === "function", "job_id_generator_required");
  requireDependency(typeof createScopedGrant === "function", "grant_factory_required");
  requireDependency(typeof now === "function", "clock_required");
  requireDependency(typeof setTimer === "function" && typeof clearTimer === "function", "timer_required");
  requireDependency(Number.isInteger(idleTimeoutMs) && idleTimeoutMs > 0, "invalid_idle_timeout");
  requireDependency(Number.isInteger(millisecondsPerMinute) && millisecondsPerMinute > 0, "invalid_time_scale");
  requireDependency(Number.isInteger(maxAccumulatedOutputBytes) && maxAccumulatedOutputBytes > 0, "invalid_output_limit");
  requireDependency(Number.isInteger(cleanupTimeoutMs) && cleanupTimeoutMs > 0, "invalid_cleanup_timeout");
  requireDependency(Number.isInteger(persistenceTimeoutMs) && persistenceTimeoutMs > 0, "invalid_persistence_timeout");
  requireDependency(Number.isInteger(approvalTimeoutMs) && approvalTimeoutMs > 0, "invalid_approval_timeout");
  requireDependency(Array.isArray(initialStatuses), "invalid_initial_statuses");

  const jobs = new Map();
  const runtimeCleanups = new WeakMap();
  const leaseReleases = new WeakMap();

  for (const snapshot of initialStatuses) {
    const redacted = redactor.redactJson(snapshot);
    const sanitized = redacted?.error === undefined
      ? redacted
      : { ...redacted, error: normalizePublicError(redacted.error) };
    if (typeof sanitized?.jobId !== "string" || !TERMINAL_STATUSES.has(sanitized.status) || jobs.has(sanitized.jobId)) {
      throw new CompanionJobError("invalid_core_configuration", "invalid_initial_status");
    }
    const done = deferred();
    done.resolve(clone(sanitized));
    jobs.set(sanitized.jobId, { snapshot: sanitized, done });
  }

  function getJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new CompanionJobError("job_not_found", "unknown_job");
    return job;
  }

  function requestStop(job, category) {
    if (job.stopCategory || TERMINAL_STATUSES.has(job.snapshot.status)) return;
    job.stopCategory = category;
    job.abortController?.abort(category);
    job.stopSignal?.reject(new StopRequested(category));
  }

  async function awaitInterruptible(job, operation, {
    onAbandon,
    onLateValue,
    onLateError,
  } = {}) {
    let abandoned = false;
    const operationPromise = Promise.resolve().then(operation);
    operationPromise.then(
      (value) => {
        if (!abandoned || !onLateValue) return;
        Promise.resolve().then(() => onLateValue(value)).catch(() => {});
      },
      () => {
        if (!abandoned || !onLateError) return;
        Promise.resolve().then(() => onLateError()).catch(() => {});
      },
    );
    try {
      return await Promise.race([operationPromise, job.stopSignal.promise]);
    } catch (error) {
      if (error instanceof StopRequested) {
        abandoned = true;
        if (onLateValue || onLateError || onAbandon) job.cleanupUncertain = true;
        onAbandon?.();
      }
      throw error;
    }
  }

  function persistenceFailureSnapshot(job) {
    const fallback = {
      jobId: job.snapshot.jobId,
      status: "failed",
      error: { category: "protocol_error", source: "unknown", code: "persistence_failed" },
      ...(typeof job.snapshot.workspace === "string" ? { workspace: job.snapshot.workspace } : {}),
      ...(Object.hasOwn(job.snapshot, "worktreePath") ? { worktreePath: job.snapshot.worktreePath } : {}),
      output: job.output,
    };
    try {
      return redactor.redactJson(fallback);
    } catch {
      return {
        jobId: job.snapshot.jobId,
        status: "failed",
        error: { category: "protocol_error" },
        ...(typeof job.snapshot.workspace === "string" ? { workspace: job.snapshot.workspace } : {}),
        ...(Object.hasOwn(job.snapshot, "worktreePath") ? { worktreePath: job.snapshot.worktreePath } : {}),
        output: "",
      };
    }
  }

  async function persistWithDeadline(snapshot) {
    const operation = Promise.resolve().then(() => persistStatus(clone(snapshot)));
    const observed = operation.then(
      () => ({ succeeded: true }),
      () => ({ succeeded: false }),
    );
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve({ succeeded: false }), persistenceTimeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([observed, timeout]);
    clearTimer(timer);
    if (!outcome.succeeded) throw new PersistenceFailure();
  }

  async function publish(job, patch, { interruptible = true } = {}) {
    const candidate = { ...job.snapshot, ...patch };
    if (candidate.status !== "awaiting_approval") delete candidate.approval;
    const next = redactor.redactJson(candidate);
    if (!ALLOWED_STATUSES.has(next.status)) throw new CompanionJobError("invalid_job_status", "unsupported_status");
    const terminal = TERMINAL_STATUSES.has(next.status);
    if (!terminal) job.snapshot = next;
    if (job.persistenceFailed) {
      job.snapshot = next;
      return clone(next);
    }

    const persist = () => persistWithDeadline(next);
    try {
      if (interruptible) await awaitInterruptible(job, persist);
      else await persist();
    } catch (error) {
      if (error instanceof StopRequested) throw error;
      job.persistenceFailed = true;
      if (!TERMINAL_STATUSES.has(next.status)) requestStop(job, "protocol_error");
      job.snapshot = persistenceFailureSnapshot(job);
      throw new PersistenceFailure();
    }
    job.snapshot = next;
    return clone(next);
  }

  function clearTimers(job) {
    clearTimer(job.hardTimer);
    clearTimer(job.idleTimer);
    job.hardTimer = undefined;
    job.idleTimer = undefined;
  }

  function armHardTimer(job) {
    const remaining = Math.max(0, job.deadline - now());
    job.hardTimer = setTimer(() => requestStop(job, "timeout"), remaining);
    job.hardTimer.unref?.();
  }

  function armIdleTimer(job) {
    clearTimer(job.idleTimer);
    if (job.activeExecutions?.size > 0) return;
    const remaining = job.deadline - now();
    if (remaining <= 0) {
      requestStop(job, "timeout");
      return;
    }
    job.idleTimer = setTimer(() => requestStop(job, "timeout"), Math.min(idleTimeoutMs, remaining));
    job.idleTimer.unref?.();
  }

  function provisionalTimeoutMinutes(rawRequest) {
    try {
      const scoped = rawRequest?.access === "scoped-edit" || rawRequest?.scope !== undefined;
      const fallback = scoped ? 15 : 30;
      const maximum = scoped ? 30 : 120;
      return Number.isInteger(rawRequest?.timeout_minutes)
        && rawRequest.timeout_minutes >= 1
        && rawRequest.timeout_minutes <= maximum
        ? rawRequest.timeout_minutes
        : fallback;
    } catch {
      return 30;
    }
  }

  function invoke(operation) {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function waitUntilDeadline(operationPromise, deadline) {
    const observed = operationPromise.then(
      () => ({ settled: true, failed: false }),
      () => ({ settled: true, failed: true }),
    );
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      void observed;
      return { settled: false, failed: true };
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve({ settled: false, failed: true }), remaining);
    });
    const result = await Promise.race([observed, timeout]);
    clearTimer(timer);
    return result;
  }

  function cleanupRuntime(runtime, shouldCancel, deadline = Date.now() + cleanupTimeoutMs) {
    if ((typeof runtime !== "object" || runtime === null) && typeof runtime !== "function") {
      return Promise.resolve({ failed: true, shutdownConfirmed: false });
    }
    const existing = runtimeCleanups.get(runtime);
    if (existing) return existing;
    const operation = (async () => {
      let failed = false;
      let cancelConfirmed = !shouldCancel;
      if (shouldCancel && typeof runtime.cancel === "function") {
        const outcome = await waitUntilDeadline(invoke(() => runtime.cancel()), deadline);
        failed ||= outcome.failed;
        cancelConfirmed = !outcome.failed;
      }
      if (typeof runtime.dispose === "function") {
        const outcome = await waitUntilDeadline(invoke(() => runtime.dispose()), deadline);
        failed ||= outcome.failed;
        return { failed, shutdownConfirmed: !outcome.failed };
      }
      return { failed, shutdownConfirmed: cancelConfirmed };
    })();
    runtimeCleanups.set(runtime, operation);
    return operation;
  }

  function releaseLease(lease, deadline = Date.now() + cleanupTimeoutMs) {
    if ((typeof lease !== "object" || lease === null) && typeof lease !== "function") {
      return Promise.resolve(true);
    }
    const existing = leaseReleases.get(lease);
    if (existing) return existing;
    const operation = typeof lease.release === "function"
      ? waitUntilDeadline(invoke(() => lease.release()), deadline).then((outcome) => outcome.failed)
      : Promise.resolve(true);
    leaseReleases.set(lease, operation);
    return operation;
  }

  function normalizedWriteIntentApproval(job, approval) {
    if (!isPlainRecord(approval)
      || approval.type !== "write_intent"
      || (approval.operation !== "replace_text" && approval.operation !== "create_text")
      || typeof approval.path !== "string"
      || byteLength(approval.path) === 0
      || byteLength(approval.path) > MAX_FILE_PATH_BYTES
      || typeof approval.operationFingerprint !== "string"
      || !SHA256.test(approval.operationFingerprint)
      || (approval.operation === "replace_text" && (typeof approval.expectedSha256 !== "string" || !SHA256.test(approval.expectedSha256)))
      || (approval.operation === "create_text" && approval.allowCreate !== true)
      || (approval.deadline !== undefined
        && (!Number.isFinite(approval.deadline) || approval.deadline < now() || approval.deadline > job.deadline))) {
      return null;
    }
    return {
      type: "write_intent",
      operation: approval.operation,
      path: approval.path,
      ...(approval.operation === "replace_text" ? { expectedSha256: approval.expectedSha256 } : { allowCreate: true }),
      operationFingerprint: approval.operationFingerprint,
      ...(approval.deadline === undefined ? {} : { deadline: approval.deadline }),
    };
  }

  async function onRuntimeEvent(job, event) {
    if (TERMINAL_STATUSES.has(job.snapshot.status) || job.stopCategory) return;
    if (event?.type === "execution_started") job.activeExecutions.add(event.itemId);
    if (event?.type === "execution_completed") job.activeExecutions.delete(event.itemId);
    armIdleTimer(job);
    if (event?.type === "broker_state") {
      if (!Array.isArray(event.filesChanged)
        || event.filesChanged.length > MAX_FILES_CHANGED
        || event.filesChanged.some((file) => typeof file !== "string" || byteLength(file) > MAX_FILE_PATH_BYTES)
        || typeof event.recoveryRequired !== "boolean"
        || (event.recoveryId !== undefined
          && (typeof event.recoveryId !== "string" || byteLength(event.recoveryId) > MAX_SESSION_ID_BYTES))
        || (event.recoveryOperationIds !== undefined && !validRecoveryOperationIds(event.recoveryOperationIds))) {
        throw new CompanionJobError("protocol_error", "invalid_broker_state");
      }
      await publish(job, {
        status: "running",
        filesChanged: event.filesChanged,
        ...(event.recoveryRequired ? { recoveryRequired: true } : {}),
        ...(typeof event.recoveryId === "string" ? { recoveryId: event.recoveryId } : {}),
        ...(event.recoveryRequired ? { recoverySources: ["journal"] } : {}),
        ...(event.recoveryOperationIds !== undefined ? { recoveryOperationIds: event.recoveryOperationIds } : {}),
      });
      return;
    }
    if (event?.type === "assistant_delta" && typeof event.text === "string") {
      const remaining = maxAccumulatedOutputBytes - byteLength(job.output);
      if (remaining > 0) {
        const sanitizedDelta = redactor.sanitizeForDisplay(event.text);
        const combined = redactor.sanitizeForDisplay(`${job.output}${sanitizedDelta}`);
        job.output = utf8Prefix(combined, maxAccumulatedOutputBytes);
      }
      await publish(job, { status: "running", output: job.output });
      return;
    }
    if (event?.type === "approval_required") {
      await publish(job, { status: "awaiting_approval", approval: event.approval ?? null });
      return;
    }
    if (event?.type === "write_intent") {
      const approval = normalizedWriteIntentApproval(job, event.approval);
      if (!approval) throw new CompanionJobError("protocol_error", "invalid_write_intent");
      await publish(job, { status: "awaiting_approval", approval });
    }
  }

  async function cleanup(job, shouldCancel) {
    clearTimers(job);
    const deadline = Date.now() + cleanupTimeoutMs;
    let failed = false;
    let runtimeCleanupConfirmed = true;
    if (job.runtime) {
      const runtimeCleanup = await cleanupRuntime(job.runtime, shouldCancel, deadline);
      failed ||= runtimeCleanup.failed;
      runtimeCleanupConfirmed = runtimeCleanup.shutdownConfirmed;
    }
    if (job.lease && !job.leaseReleaseDeferred && runtimeCleanupConfirmed) {
      const leaseFailed = await releaseLease(job.lease, deadline);
      failed ||= leaseFailed;
    }
    return failed;
  }

  function terminalPatchForError(job, error) {
    const classified = normalizePublicError(error instanceof StopRequested
      ? { category: error.category, source: error.category === "timeout" ? "mcp_execution" : "unknown" }
      : classifyCompanionError(error));
    const metadata = {
      ...(Array.isArray(error?.filesChanged) ? { filesChanged: error.filesChanged } : {}),
      ...(typeof error?.recoveryRequired === "boolean" ? { recoveryRequired: error.recoveryRequired } : {}),
      ...(typeof error?.recoveryId === "string" ? { recoveryId: error.recoveryId } : {}),
      ...(validRecoverySources(error?.recoverySources) ? { recoverySources: error.recoverySources } : {}),
      ...(validRecoveryOperationIds(error?.recoveryOperationIds) ? { recoveryOperationIds: error.recoveryOperationIds } : {}),
    };
    const model = modelPatch(job);
    return classified.category === "cancelled"
      ? { status: "cancelled", error: classified, output: job.output, ...model, ...metadata }
      : { status: "failed", error: classified, output: job.output, ...model, ...metadata };
  }

  function modelPatch(job) {
    return typeof job.request?.model === "string" ? { model: job.request.model } : {};
  }

  function scrubTerminalReferences(job) {
    clearTimers(job);
    job.abortController = null;
    job.stopSignal = null;
    job.request = null;
    job.runtime = null;
    job.scopeGrant = null;
    job.lease = null;
    job.output = "";
    job.detachAbort?.();
  }

  async function runGeminiTask(rawRequest, executionHooks = {}) {
    const generatedJobId = generateJobId();
    if (typeof generatedJobId !== "string"
      || generatedJobId.trim().length === 0
      || byteLength(generatedJobId) > 512) {
      throw new CompanionJobError("invalid_job_id", "job_id_must_be_unique");
    }
    let jobId;
    try {
      jobId = redactor.redactJson(generatedJobId);
    } catch {
      throw new CompanionJobError("invalid_job_id", "job_id_must_be_unique");
    }
    if (jobs.has(jobId)) throw new CompanionJobError("invalid_job_id", "job_id_must_be_unique");
    const job = {
      snapshot: redactor.redactJson({ jobId, status: "starting" }),
      abortController: new AbortController(),
      stopSignal: deferred(),
      done: deferred(),
      output: "",
      request: null,
      scopeGrant: null,
      runtime: null,
      lease: null,
      stopCategory: null,
      persistenceFailed: false,
      leaseReleaseDeferred: false,
      cleanupUncertain: false,
      activeExecutions: new Set(),
      startedAt: now(),
      timeoutMinutes: provisionalTimeoutMinutes(rawRequest),
    };
    job.deadline = job.startedAt + (job.timeoutMinutes * millisecondsPerMinute);
    // The rejection is observed here as well as by lifecycle races so idle jobs never emit an unhandled rejection.
    job.stopSignal.promise.catch(() => {});
    jobs.set(jobId, job);
    const hostAbort = () => requestStop(job, "cancelled");
    if (executionHooks.signal) {
      executionHooks.signal.addEventListener("abort", hostAbort, { once: true });
      job.detachAbort = () => executionHooks.signal.removeEventListener("abort", hostAbort);
      if (executionHooks.signal.aborted) hostAbort();
    }

    let terminalPatch;
    try {
      await publish(job, { status: "starting" });
      if (typeof executionHooks?.onStarted === "function") {
        try { await executionHooks.onStarted(jobId); } catch { /* progress reporting is non-gating */ }
      }
      armHardTimer(job);
      // Preserve an extensible job-local request: legacy runtime preparation attaches
      // resumeContext after validation, while the original validated result remains frozen.
      job.request = { ...await awaitInterruptible(job, () => validateRequest(rawRequest)) };
      if (job.request.scoped) {
        const runtimeFingerprint = typeof resolveScopedRuntimeFingerprint === "function"
          ? await awaitInterruptible(job, () => resolveScopedRuntimeFingerprint({
            jobId,
            request: job.request,
            signal: job.abortController.signal,
          }))
          : job.request.runtimeFingerprint;
        if (typeof runtimeFingerprint !== "string" || runtimeFingerprint.length === 0) {
          throw new CompanionJobError("runtime_not_supported", "scoped_runtime_identity_invalid");
        }
        const expiresAt = job.deadline;
        const taskHash = createHash("sha256").update(job.request.task, "utf8").digest("hex");
        const resolvedScope = job.request.resolvedScope;
        job.scopeGrant = createScopedGrant({
          jobId,
          resolvedScope,
          taskHash,
          runtimeFingerprint,
          expiresAt,
          now,
        });
        if (!validScopedGrant(job.scopeGrant, {
          jobId,
          resolvedScope,
          taskHash,
          runtimeFingerprint,
          expiresAt,
        })) {
          throw new CompanionJobError("protocol_error", "invalid_scoped_grant");
        }
      }
      let compatibility;
      if (usesPreparedRuntime) {
        const prepared = await awaitInterruptible(
          job,
          () => prepareRuntime({
            jobId,
            request: job.request,
            grant: job.scopeGrant,
            signal: job.abortController.signal,
          }),
          { onLateValue: (lateRuntime) => cleanupRuntime(lateRuntime, true) },
        );
        if ((typeof prepared !== "object" || prepared === null) || typeof prepared.run !== "function") {
          throw new CompanionJobError("protocol_error", "invalid_prepared_runtime");
        }
        job.runtime = prepared;
        compatibility = prepared.compatibility;
        if (compatibility?.status !== "compatible") {
          throw new CompanionJobError("app_server_incompatible", "prepared_runtime_not_compatible");
        }
      } else {
        compatibility = await awaitInterruptible(job, () => compatibilityAdapter.check());
      }
      const publicAccess = job.request.publicAccess ?? job.request.access;
      const repository = publicAccess === "workspace-write" && typeof workspaceManager?.resolveRepository === "function"
        ? await awaitInterruptible(job, () => workspaceManager.resolveRepository({ ...job.request, access: publicAccess }))
        : null;
      if (publicAccess === "workspace-write") {
        job.lease = await awaitInterruptible(
          job,
          () => workspaceLeases.acquire({
            ...job.request,
            access: "workspace-write",
            workspace: repository?.repositoryRoot ?? job.request.workspace,
          }),
          { onLateValue: (lateLease) => releaseLease(lateLease) },
        );
      }
      let workspace;
      if (workspaceManager) {
        const workspaceSetupLease = job.lease;
        const workspaceSetupRuntime = job.runtime;
        const finishAbandonedWorkspaceSetup = async () => {
          const runtimeCleanup = workspaceSetupRuntime
            ? await cleanupRuntime(workspaceSetupRuntime, true)
            : { shutdownConfirmed: true };
          if (workspaceSetupLease && runtimeCleanup.shutdownConfirmed) await releaseLease(workspaceSetupLease);
        };
        workspace = await awaitInterruptible(
          job,
          () => workspaceManager.prepare(job.request, jobId, repository),
          {
            onAbandon: () => { if (workspaceSetupLease) job.leaseReleaseDeferred = true; },
            onLateValue: finishAbandonedWorkspaceSetup,
            onLateError: finishAbandonedWorkspaceSetup,
          },
        );
      } else {
        workspace = { executionWorkspace: job.request.workspace, worktreePath: null, head: null };
      }
      if (typeof workspace?.executionWorkspace !== "string") {
        throw new CompanionJobError("protocol_error", "invalid_execution_workspace");
      }
      await executionHooks.onWorkspacePrepared?.(workspace, job.request);
      if (workspace.worktreePath) {
        await publish(job, {
          status: "starting",
          workspace: job.request.workspace,
          worktreePath: workspace.worktreePath,
          access: job.request.access,
          ...modelPatch(job),
        });
      }
      let runtime = job.runtime;
      if (!usesPreparedRuntime) {
        const runtimeSetupLease = job.lease;
        runtime = await awaitInterruptible(
          job,
          () => createRuntime({
            jobId,
            request: job.request,
            compatibility,
            signal: job.abortController.signal,
          }),
          {
            onAbandon: () => {
              if (runtimeSetupLease) job.leaseReleaseDeferred = true;
            },
            onLateValue: async (lateRuntime) => {
              const runtimeCleanup = await cleanupRuntime(lateRuntime, true);
              if (runtimeSetupLease && runtimeCleanup.shutdownConfirmed) await releaseLease(runtimeSetupLease);
            },
            onLateError: () => (runtimeSetupLease ? releaseLease(runtimeSetupLease) : undefined),
          },
        );
      }
      if ((typeof runtime !== "object" || runtime === null) || typeof runtime.run !== "function") {
        throw new CompanionJobError("protocol_error", "invalid_runtime");
      }
      job.runtime = runtime;
      await publish(job, {
        status: "running",
        workspace: job.request.workspace,
        worktreePath: workspace.worktreePath ?? null,
        access: job.request.access,
        effort: job.request.effort,
        ...modelPatch(job),
        compatibilityWarnings: compatibility?.warnings ?? [],
      });
      armIdleTimer(job);
      const rawResult = await awaitInterruptible(job, () => runtime.run({
        jobId,
        request: {
          ...job.request,
          approvalDeadline: job.deadline,
          approvalTimeoutMs,
        },
        executionWorkspace: workspace.executionWorkspace,
        worktreePath: workspace.worktreePath ?? null,
        head: workspace.head ?? null,
        signal: job.abortController.signal,
        onEvent: (event) => onRuntimeEvent(job, event),
        requestDecision: executionHooks?.requestDecision,
      }));
      const result = normalizeRuntimeResult(redactor, rawResult);
      if (workspace.worktreePath && typeof workspaceManager?.collectChanges === "function") {
        result.filesChanged = await awaitInterruptible(job, () => workspaceManager.collectChanges(workspace));
      }
      await awaitInterruptible(job, () => executionHooks.onResult?.(result), { onAbandon: () => {} });
      terminalPatch = {
        status: "completed",
        ...(Object.hasOwn(result, "sessionId") ? { sessionId: result.sessionId } : {}),
        finalAnswer: result.finalAnswer,
        filesChanged: result.filesChanged,
        tests: result.tests,
        ...modelPatch(job),
        ...(Object.hasOwn(result, "recoveryRequired") ? { recoveryRequired: result.recoveryRequired } : {}),
        ...(Object.hasOwn(result, "recoveryId") ? { recoveryId: result.recoveryId } : {}),
        ...(Object.hasOwn(result, "recoverySources") ? { recoverySources: result.recoverySources } : {}),
        ...(Object.hasOwn(result, "recoveryOperationIds") ? { recoveryOperationIds: result.recoveryOperationIds } : {}),
        workspace: job.request.workspace,
        worktreePath: workspace.worktreePath ?? null,
        output: job.output,
      };
    } catch (error) {
      terminalPatch = terminalPatchForError(job, error);
    }

    const cleanupFailed = await cleanup(job, terminalPatch.status !== "completed");
    try {
      const summary = job.runtime?.recoverySummary?.();
      if (summary) {
        if (Array.isArray(summary.filesChanged)) terminalPatch.filesChanged = summary.filesChanged;
        if (summary.recoveryRequired === true) {
           terminalPatch.recoveryRequired = true;
           if (typeof summary.recoveryId === "string") terminalPatch.recoveryId = summary.recoveryId;
          terminalPatch.recoverySources = mergeRecoverySources(terminalPatch.recoverySources, ["journal"]);
          if (!validRecoveryOperationIds(summary.recoveryOperationIds ?? [])) {
            throw new CompanionJobError("protocol_error", "invalid_recovery_summary");
          }
          terminalPatch.recoveryOperationIds = mergeRecoveryOperationIds(
            terminalPatch.recoveryOperationIds,
            summary.recoveryOperationIds,
          );
          if (terminalPatch.status === "completed") {
            terminalPatch = {
              ...terminalPatch,
              status: "failed",
              error: normalizePublicError({ category: "protocol_error", source: "unknown" }),
            };
          }
        }
      }
    } catch {
      terminalPatch = { ...terminalPatch, status: "failed", error: normalizePublicError({ category: "protocol_error", source: "unknown" }),
        recoveryRequired: true, recoverySources: mergeRecoverySources(terminalPatch.recoverySources, ["unknown"]) };
    }
    if (cleanupFailed || job.cleanupUncertain) {
      terminalPatch = {
        ...terminalPatch,
        ...(cleanupFailed && terminalPatch.status === "completed"
          ? { status: "failed", error: normalizePublicError({ category: "protocol_error", source: "unknown" }) }
          : {}),
        recoveryRequired: true,
        recoverySources: mergeRecoverySources(terminalPatch.recoverySources, ["cleanup"]),
      };
    }
    try {
      await publish(job, terminalPatch, { interruptible: false });
    } catch {
      if (!TERMINAL_STATUSES.has(job.snapshot.status)) {
        job.snapshot = persistenceFailureSnapshot(job);
      }
    }

    try { await executionHooks.onCleanup?.(!cleanupFailed && !job.cleanupUncertain && !job.persistenceFailed); } catch { job.cleanupUncertain = true; }
    const result = clone(job.snapshot);
    job.done.resolve(result);
    scrubTerminalReferences(job);
    return clone(result);
  }

  function getGeminiStatus(jobId) {
    return clone(getJob(jobId).snapshot);
  }

  async function cancelGeminiTask(jobId) {
    const job = getJob(jobId);
    if (TERMINAL_STATUSES.has(job.snapshot.status)) return clone(job.snapshot);
    requestStop(job, "cancelled");
    return job.done.promise;
  }

  return Object.freeze({ runGeminiTask, getGeminiStatus, cancelGeminiTask });
}
