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

function clone(value) {
  return structuredClone(value);
}

function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�$/u, "");
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
}) {
  requireDependency(typeof validateRequest === "function", "validate_request_required");
  requireDependency(typeof compatibilityAdapter?.check === "function", "compatibility_adapter_required");
  requireDependency(typeof workspaceLeases?.acquire === "function", "workspace_leases_required");
  requireDependency(typeof createRuntime === "function", "runtime_factory_required");
  requireDependency(typeof redactor?.redactJson === "function" && typeof redactor?.redactError === "function", "redactor_required");
  requireDependency(typeof persistStatus === "function", "persistence_required");
  requireDependency(typeof generateJobId === "function", "job_id_generator_required");
  requireDependency(Number.isInteger(idleTimeoutMs) && idleTimeoutMs > 0, "invalid_idle_timeout");
  requireDependency(Number.isInteger(millisecondsPerMinute) && millisecondsPerMinute > 0, "invalid_time_scale");
  requireDependency(Number.isInteger(maxAccumulatedOutputBytes) && maxAccumulatedOutputBytes > 0, "invalid_output_limit");

  const jobs = new Map();

  function getJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new CompanionJobError("job_not_found", "unknown_job");
    return job;
  }

  async function publish(job, patch) {
    const candidate = { ...job.snapshot, ...patch };
    if (candidate.status !== "awaiting_approval") delete candidate.approval;
    const next = redactor.redactJson(candidate);
    if (!ALLOWED_STATUSES.has(next.status)) throw new CompanionJobError("invalid_job_status", "unsupported_status");
    job.snapshot = next;
    await persistStatus(clone(next));
    return clone(next);
  }

  function clearTimers(job) {
    clearTimeout(job.hardTimer);
    clearTimeout(job.idleTimer);
    job.hardTimer = undefined;
    job.idleTimer = undefined;
  }

  function callCancelOnce(job) {
    if (job.cancelCalled || typeof job.runtime?.cancel !== "function") return Promise.resolve();
    job.cancelCalled = true;
    return Promise.resolve().then(() => job.runtime.cancel()).catch(() => {});
  }

  function requestStop(job, category) {
    if (job.stopCategory || TERMINAL_STATUSES.has(job.snapshot.status)) return;
    job.stopCategory = category;
    job.abortController.abort(category);
    void callCancelOnce(job);
    job.stopSignal.reject(new StopRequested(category));
  }

  function armIdleTimer(job) {
    clearTimeout(job.idleTimer);
    const hardDuration = job.request.timeoutMinutes * millisecondsPerMinute;
    job.idleTimer = setTimeout(() => requestStop(job, "timeout"), Math.min(idleTimeoutMs, hardDuration));
    job.idleTimer.unref?.();
  }

  function armTimers(job) {
    const hardDuration = job.request.timeoutMinutes * millisecondsPerMinute;
    job.hardTimer = setTimeout(() => requestStop(job, "timeout"), hardDuration);
    job.hardTimer.unref?.();
    armIdleTimer(job);
  }

  async function onRuntimeEvent(job, event) {
    if (TERMINAL_STATUSES.has(job.snapshot.status) || job.stopCategory) return;
    armIdleTimer(job);
    if (event?.type === "assistant_delta" && typeof event.text === "string") {
      const remaining = maxAccumulatedOutputBytes - Buffer.byteLength(job.output, "utf8");
      if (remaining > 0) {
        job.output += utf8Prefix(event.text, remaining);
      }
      await publish(job, { status: "running", output: job.output });
      return;
    }
    if (event?.type === "approval_required") {
      await publish(job, { status: "awaiting_approval", approval: event.approval ?? null });
    }
  }

  async function cleanup(job) {
    clearTimers(job);
    let failed = false;
    if (job.runtime && !job.disposed) {
      job.disposed = true;
      try { await job.runtime.dispose?.(); } catch { failed = true; }
    }
    if (job.lease && !job.leaseReleased) {
      job.leaseReleased = true;
      try { await job.lease.release(); } catch { failed = true; }
    }
    return failed;
  }

  async function runGeminiTask(rawRequest) {
    const generatedJobId = generateJobId();
    if (typeof generatedJobId !== "string"
      || generatedJobId.trim().length === 0
      || Buffer.byteLength(generatedJobId, "utf8") > 512) {
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
      runtime: null,
      lease: null,
      cancelCalled: false,
      disposed: false,
      leaseReleased: false,
      stopCategory: null,
    };
    // Avoid an unhandled rejection when the job completes before a stop is requested.
    job.stopSignal.promise.catch(() => {});
    jobs.set(jobId, job);
    await persistStatus(clone(job.snapshot));

    let terminalPatch;
    try {
      job.request = await validateRequest(rawRequest);
      if (job.stopCategory) throw new StopRequested(job.stopCategory);
      const compatibility = await compatibilityAdapter.check();
      if (job.stopCategory) throw new StopRequested(job.stopCategory);
      job.lease = await workspaceLeases.acquire(job.request);
      if (job.stopCategory) throw new StopRequested(job.stopCategory);
      job.runtime = await createRuntime({
        jobId,
        request: job.request,
        compatibility,
        signal: job.abortController.signal,
      });
      if (typeof job.runtime?.run !== "function") throw new CompanionJobError("protocol_error", "invalid_runtime");
      if (job.stopCategory) throw new StopRequested(job.stopCategory);
      await publish(job, {
        status: "running",
        workspace: job.request.workspace,
        access: job.request.access,
        effort: job.request.effort,
        compatibilityWarnings: compatibility?.warnings ?? [],
      });
      armTimers(job);
      const result = await Promise.race([
        Promise.resolve().then(() => job.runtime.run({
          request: job.request,
          signal: job.abortController.signal,
          onEvent: (event) => onRuntimeEvent(job, event),
        })),
        job.stopSignal.promise,
      ]);
      terminalPatch = {
        status: "completed",
        ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
        finalAnswer: result?.finalAnswer ?? job.output,
        filesChanged: result?.filesChanged ?? [],
        tests: result?.tests ?? [],
        output: job.output,
      };
    } catch (error) {
      const category = error instanceof StopRequested ? error.category : categoryFor(error);
      terminalPatch = category === "cancelled"
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

    const cleanupFailed = await cleanup(job);
    if (cleanupFailed && terminalPatch.status === "completed") {
      terminalPatch = { status: "failed", error: { category: "protocol_error" }, output: job.output };
    }
    try {
      await publish(job, terminalPatch);
    } catch (error) {
      if (error?.code !== "redaction_failed") throw error;
      await publish(job, {
        status: "failed",
        error: { category: "protocol_error" },
        output: "",
      });
    }
    job.done.resolve(clone(job.snapshot));
    return clone(job.snapshot);
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
