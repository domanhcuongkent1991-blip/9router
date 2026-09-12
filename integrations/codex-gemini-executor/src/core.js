const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ALLOWED_STATUSES = new Set(["starting", "running", "awaiting_approval", ...TERMINAL_STATUSES]);
const RUNTIME_RESULT_KEYS = new Set(["sessionId", "finalAnswer", "filesChanged", "tests"]);
const MAX_SESSION_ID_BYTES = 512;
const MAX_FINAL_ANSWER_BYTES = 64 * 1024;
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
  requireDependency(Number.isInteger(idleTimeoutMs) && idleTimeoutMs > 0, "invalid_idle_timeout");
  requireDependency(Number.isInteger(millisecondsPerMinute) && millisecondsPerMinute > 0, "invalid_time_scale");
  requireDependency(Number.isInteger(maxAccumulatedOutputBytes) && maxAccumulatedOutputBytes > 0, "invalid_output_limit");
  requireDependency(Number.isInteger(cleanupTimeoutMs) && cleanupTimeoutMs > 0, "invalid_cleanup_timeout");
  requireDependency(Number.isInteger(persistenceTimeoutMs) && persistenceTimeoutMs > 0, "invalid_persistence_timeout");
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
      timer = setTimeout(() => resolve({ succeeded: false }), persistenceTimeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([observed, timeout]);
    clearTimeout(timer);
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
    if (job.activeExecutions?.size > 0) return;
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

  async function onRuntimeEvent(job, event) {
    if (TERMINAL_STATUSES.has(job.snapshot.status) || job.stopCategory) return;
    if (event?.type === "execution_started") job.activeExecutions.add(event.itemId);
    if (event?.type === "execution_completed") job.activeExecutions.delete(event.itemId);
    armIdleTimer(job);
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
    const category = classified.category;
    const model = modelPatch(job);
    return category === "cancelled"
      ? { status: "cancelled", error: classified, output: job.output, ...model }
      : {
          status: "failed",
          error: classified,
          output: job.output,
          ...model,
        };
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
      runtime: null,
      lease: null,
      stopCategory: null,
      persistenceFailed: false,
      leaseReleaseDeferred: false,
      cleanupUncertain: false,
      activeExecutions: new Set(),
    };
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
      // Unfrozen shallow copy: prepareRuntime implementations attach
      // request.resumeContext (session resume) on this object; the validated
      // request itself is frozen at the validation boundary.
      job.request = {
        ...await awaitInterruptible(job, () => validateRequest(rawRequest)),
      };
      armHardTimer(job);
      let compatibility;
      if (usesPreparedRuntime) {
        const prepared = await awaitInterruptible(
          job,
          () => prepareRuntime({
            jobId,
            request: job.request,
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
      const repository = job.request.access === "workspace-write" && typeof workspaceManager?.resolveRepository === "function"
        ? await awaitInterruptible(job, () => workspaceManager.resolveRepository(job.request))
        : null;
      if (job.request.access === "workspace-write") {
        job.lease = await awaitInterruptible(
          job,
          () => workspaceLeases.acquire({
            ...job.request,
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
        request: job.request,
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
        workspace: job.request.workspace,
        worktreePath: workspace.worktreePath ?? null,
        output: job.output,
      };
    } catch (error) {
      terminalPatch = terminalPatchForError(job, error);
    }

    const cleanupFailed = await cleanup(job, terminalPatch.status !== "completed");
    if (cleanupFailed && terminalPatch.status === "completed") {
      terminalPatch = { status: "failed", error: { category: "protocol_error", source: "unknown" }, output: job.output };
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
import { classifyCompanionError, normalizePublicError } from "./error-classification.js";
