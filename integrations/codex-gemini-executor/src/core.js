const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ALLOWED_STATUSES = new Set(["starting", "running", "awaiting_approval", ...TERMINAL_STATUSES]);
const ERROR_CATEGORIES = new Set([
  "router_unavailable",
  "model_unavailable",
  "provider_auth_failed",
  "provider_quota_exceeded",
  "app_server_incompatible",
  "workspace_dirty",
  "workspace_locked",
  "approval_required",
  "timeout",
  "cancelled",
  "protocol_error",
  "invalid_request",
]);
const RUNTIME_RESULT_KEYS = new Set(["sessionId", "finalAnswer", "filesChanged", "tests"]);
const MAX_SESSION_ID_BYTES = 512;
const MAX_FILES_CHANGED = 1_024;
const MAX_FILE_PATH_BYTES = 4_096;
const MAX_TEST_RECORDS = 256;
const MAX_TEST_RECORD_BYTES = 16 * 1_024;

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

function categoryFor(error) {
  try {
    return ERROR_CATEGORIES.has(error?.code) ? error.code : "protocol_error";
  } catch {
    return "protocol_error";
  }
}

function sanitizeError(redactor, error) {
  try {
    return redactor.redactError(error instanceof Error ? error : new Error("Unknown failure"));
  } catch {
    return { name: "Error", message: "Sanitized failure" };
  }
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
  redactor,
  persistStatus = async () => {},
  generateJobId = () => `job_${crypto.randomUUID()}`,
  idleTimeoutMs = 5 * 60_000,
  millisecondsPerMinute = 60_000,
  maxAccumulatedOutputBytes = 32 * 1024,
  cleanupTimeoutMs = 5_000,
}) {
  requireDependency(typeof validateRequest === "function", "validate_request_required");
  requireDependency(typeof compatibilityAdapter?.check === "function", "compatibility_adapter_required");
  requireDependency(typeof workspaceLeases?.acquire === "function", "workspace_leases_required");
  requireDependency(typeof createRuntime === "function", "runtime_factory_required");
  requireDependency(typeof redactor?.redactJson === "function"
    && typeof redactor?.redactError === "function"
    && typeof redactor?.sanitizeForDisplay === "function", "redactor_required");
  requireDependency(typeof persistStatus === "function", "persistence_required");
  requireDependency(typeof generateJobId === "function", "job_id_generator_required");
  requireDependency(Number.isInteger(idleTimeoutMs) && idleTimeoutMs > 0, "invalid_idle_timeout");
  requireDependency(Number.isInteger(millisecondsPerMinute) && millisecondsPerMinute > 0, "invalid_time_scale");
  requireDependency(Number.isInteger(maxAccumulatedOutputBytes) && maxAccumulatedOutputBytes > 0, "invalid_output_limit");
  requireDependency(Number.isInteger(cleanupTimeoutMs) && cleanupTimeoutMs > 0, "invalid_cleanup_timeout");

  const jobs = new Map();
  const runtimeCleanups = new WeakMap();
  const leaseReleases = new WeakMap();

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

  async function awaitInterruptible(job, operation, onLateValue) {
    let abandoned = false;
    const operationPromise = Promise.resolve().then(operation);
    if (onLateValue) {
      operationPromise.then((value) => {
        if (!abandoned) return;
        Promise.resolve().then(() => onLateValue(value)).catch(() => {});
      }, () => {});
    }
    try {
      return await Promise.race([operationPromise, job.stopSignal.promise]);
    } catch (error) {
      if (error instanceof StopRequested) abandoned = true;
      throw error;
    }
  }

  function persistenceFailureSnapshot(job) {
    const fallback = {
      jobId: job.snapshot.jobId,
      status: "failed",
      error: {
        category: "protocol_error",
        cause: { name: "PersistenceFailure", message: "Status persistence failed" },
      },
      output: job.output,
    };
    try {
      return redactor.redactJson(fallback);
    } catch {
      return {
        jobId: job.snapshot.jobId,
        status: "failed",
        error: { category: "protocol_error" },
        output: "",
      };
    }
  }

  async function publish(job, patch, { interruptible = true } = {}) {
    const candidate = { ...job.snapshot, ...patch };
    if (candidate.status !== "awaiting_approval") delete candidate.approval;
    const next = redactor.redactJson(candidate);
    if (!ALLOWED_STATUSES.has(next.status)) throw new CompanionJobError("invalid_job_status", "unsupported_status");
    job.snapshot = next;
    if (job.persistenceFailed) return clone(next);

    const persist = () => persistStatus(clone(next));
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
    return clone(next);
  }

  function clearTimers(job) {
    clearTimeout(job.hardTimer);
    clearTimeout(job.idleTimer);
    job.hardTimer = undefined;
    job.idleTimer = undefined;
  }

  function armHardTimer(job) {
    const hardDuration = job.request.timeoutMinutes * millisecondsPerMinute;
    job.hardTimer = setTimeout(() => requestStop(job, "timeout"), hardDuration);
    job.hardTimer.unref?.();
  }

  function armIdleTimer(job) {
    clearTimeout(job.idleTimer);
    const hardDuration = job.request.timeoutMinutes * millisecondsPerMinute;
    job.idleTimer = setTimeout(() => requestStop(job, "timeout"), Math.min(idleTimeoutMs, hardDuration));
    job.idleTimer.unref?.();
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
      timer = setTimeout(() => resolve({ settled: false, failed: true }), remaining);
    });
    const result = await Promise.race([observed, timeout]);
    clearTimeout(timer);
    return result;
  }

  function cleanupRuntime(runtime, shouldCancel, deadline = Date.now() + cleanupTimeoutMs) {
    if ((typeof runtime !== "object" || runtime === null) && typeof runtime !== "function") {
      return Promise.resolve(true);
    }
    const existing = runtimeCleanups.get(runtime);
    if (existing) return existing;
    const operation = (async () => {
      let failed = false;
      if (shouldCancel && typeof runtime.cancel === "function") {
        const outcome = await waitUntilDeadline(invoke(() => runtime.cancel()), deadline);
        failed ||= outcome.failed;
      }
      if (typeof runtime.dispose === "function") {
        const outcome = await waitUntilDeadline(invoke(() => runtime.dispose()), deadline);
        failed ||= outcome.failed;
      }
      return failed;
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

  async function onRuntimeEvent(job, event) {
    if (TERMINAL_STATUSES.has(job.snapshot.status) || job.stopCategory) return;
    armIdleTimer(job);
    if (event?.type === "assistant_delta" && typeof event.text === "string") {
      const remaining = maxAccumulatedOutputBytes - byteLength(job.output);
      if (remaining > 0) {
        const boundedDelta = utf8Prefix(event.text, remaining);
        const combined = redactor.sanitizeForDisplay(`${job.output}${boundedDelta}`);
        job.output = utf8Prefix(combined, maxAccumulatedOutputBytes);
      }
      await publish(job, { status: "running", output: job.output });
      return;
    }
    if (event?.type === "approval_required") {
      await publish(job, { status: "awaiting_approval", approval: event.approval ?? null });
    }
  }

  async function cleanup(job, shouldCancel) {
    clearTimers(job);
    const deadline = Date.now() + cleanupTimeoutMs;
    let failed = false;
    if (job.runtime) {
      const runtimeFailed = await cleanupRuntime(job.runtime, shouldCancel, deadline);
      failed ||= runtimeFailed;
    }
    if (job.lease) {
      const leaseFailed = await releaseLease(job.lease, deadline);
      failed ||= leaseFailed;
    }
    return failed;
  }

  function terminalPatchForError(job, error) {
    const category = error instanceof StopRequested ? error.category : categoryFor(error);
    return category === "cancelled"
      ? { status: "cancelled", error: { category: "cancelled" }, output: job.output }
      : {
          status: "failed",
          error: {
            category,
            cause: error instanceof StopRequested
              ? { name: "StopRequested", message: "Job stopped" }
              : sanitizeError(redactor, error),
          },
          output: job.output,
        };
  }

  function scrubTerminalReferences(job) {
    clearTimers(job);
    job.abortController = null;
    job.stopSignal = null;
    job.request = null;
    job.runtime = null;
    job.lease = null;
    job.output = "";
  }

  async function runGeminiTask(rawRequest) {
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
      runtime: null,
      lease: null,
      stopCategory: null,
      persistenceFailed: false,
    };
    // The rejection is observed here as well as by lifecycle races so idle jobs never emit an unhandled rejection.
    job.stopSignal.promise.catch(() => {});
    jobs.set(jobId, job);

    let terminalPatch;
    try {
      await publish(job, { status: "starting" });
      job.request = await awaitInterruptible(job, () => validateRequest(rawRequest));
      armHardTimer(job);
      const compatibility = await awaitInterruptible(job, () => compatibilityAdapter.check());
      if (job.request.access === "workspace-write") {
        job.lease = await awaitInterruptible(
          job,
          () => workspaceLeases.acquire(job.request),
          (lateLease) => releaseLease(lateLease),
        );
      }
      const runtime = await awaitInterruptible(
        job,
        () => createRuntime({
          jobId,
          request: job.request,
          compatibility,
          signal: job.abortController.signal,
        }),
        (lateRuntime) => cleanupRuntime(lateRuntime, true),
      );
      if ((typeof runtime !== "object" || runtime === null) || typeof runtime.run !== "function") {
        throw new CompanionJobError("protocol_error", "invalid_runtime");
      }
      job.runtime = runtime;
      await publish(job, {
        status: "running",
        workspace: job.request.workspace,
        access: job.request.access,
        effort: job.request.effort,
        compatibilityWarnings: compatibility?.warnings ?? [],
      });
      armIdleTimer(job);
      const rawResult = await awaitInterruptible(job, () => runtime.run({
        request: job.request,
        signal: job.abortController.signal,
        onEvent: (event) => onRuntimeEvent(job, event),
      }));
      const result = normalizeRuntimeResult(redactor, rawResult);
      terminalPatch = {
        status: "completed",
        ...(Object.hasOwn(result, "sessionId") ? { sessionId: result.sessionId } : {}),
        finalAnswer: result.finalAnswer,
        filesChanged: result.filesChanged,
        tests: result.tests,
        output: job.output,
      };
    } catch (error) {
      terminalPatch = terminalPatchForError(job, error);
    }

    const cleanupFailed = await cleanup(job, Boolean(job.stopCategory));
    if (cleanupFailed && terminalPatch.status === "completed") {
      terminalPatch = { status: "failed", error: { category: "protocol_error" }, output: job.output };
    }
    try {
      await publish(job, terminalPatch, { interruptible: false });
    } catch {
      if (!TERMINAL_STATUSES.has(job.snapshot.status)) {
        job.snapshot = persistenceFailureSnapshot(job);
      }
    }

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
