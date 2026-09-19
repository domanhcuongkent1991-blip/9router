import test from "node:test";
import assert from "node:assert/strict";

import { createGeminiCompanionCore } from "../src/core.js";
import { createCompanionRedactor } from "../src/redaction.js";
import { validateGeminiRequest } from "../src/request.js";
import { createWorkspaceLeaseManager } from "../src/workspace-lease.js";

const SECRET = "sentinel-runtime-secret";
const baseRequest = { task: "inspect", workspace: "D:\\Repo" };

test("active execution is governed by the hard deadline, not text idle", async () => {
  const core = lifecycleCore({ idleTimeoutMs: 5, millisecondsPerMinute: 100,
    createRuntime: async () => ({ run: async ({ onEvent }) => {
      await onEvent({ type: "execution_started", itemId: "command_1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await onEvent({ type: "execution_completed", itemId: "command_1" });
      return { finalAnswer: "done", filesChanged: [], tests: [] };
    }, cancel: async () => {}, dispose: async () => {} }),
  });
  assert.equal((await core.runGeminiTask(baseRequest)).status, "completed");
});

test("notifies the owner when late setup makes shutdown uncertain", async () => {
  let confirmed;
  const pending = deferred();
  const core = lifecycleCore({ prepareRuntime: () => pending.promise });
  let id;
  const run = core.runGeminiTask(baseRequest, {
    onStarted: (jobId) => { id = jobId; },
    onCleanup: (value) => { confirmed = value; },
  });
  while (!id) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await core.cancelGeminiTask(id);
  await run;
  assert.equal(confirmed, false);
  pending.resolve({ run: async () => ({}), dispose: async () => {} });
});

test("a cancelled MCP request stops only its own job", async () => {
  const abort = new AbortController();
  const running = deferred();
  const core = lifecycleCore({ createRuntime: async () => ({
    run: () => { running.resolve(); return new Promise(() => {}); },
    cancel: async () => {}, dispose: async () => {},
  }) });
  const result = core.runGeminiTask(baseRequest, { signal: abort.signal });
  await running.promise;
  abort.abort();
  assert.equal((await result).status, "cancelled");
});

test("returns bounded source-aware failures without preserving remote bodies", async () => {
  const core = lifecycleCore({ createRuntime: async () => ({
    run: async () => {
      throw Object.assign(new Error("api_key=raw-secret"), {
        code: "app_server_session_error",
        details: { remoteSource: "provider", remoteCode: "provider_rate_limit", remoteStatus: 429 },
      });
    },
    cancel: async () => {}, dispose: async () => {},
  }) });
  const result = await core.runGeminiTask(baseRequest);
  assert.deepEqual(result.error, {
    category: "rate_limited", source: "provider", code: "provider_rate_limit", status: 429,
  });
  assert.equal(JSON.stringify(result).includes("raw-secret"), false);
});

test("does not persist caller-controlled error metadata from local failures", async () => {
  const sentinel = "sentinel-untrusted-4829";
  const persisted = [];
  const core = lifecycleCore({
    validateRequest: async () => {
      throw Object.assign(new Error("secret"), {
        code: "invalid_request", details: { field: sentinel, reason: sentinel, stage: sentinel },
      });
    },
    persistStatus: async (snapshot) => persisted.push(structuredClone(snapshot)),
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.deepEqual(result.error, {
    category: "invalid_request", source: "unknown", code: "invalid_request",
  });
  assert.equal(JSON.stringify([result, persisted]).includes(sentinel), false);
});

test("propagates classified local gate details into terminal and persisted status", async () => {
  const persisted = [];
  const core = lifecycleCore({
    validateRequest: async () => {
      throw Object.assign(new Error("api_key=sentinel-runtime-secret"), {
        code: "app_server_incompatible",
        details: { stage: "qualification", reason: "qualification_record_missing" },
      });
    },
    persistStatus: async (snapshot) => persisted.push(structuredClone(snapshot)),
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.deepEqual(result.error, {
    category: "app_server_incompatible", source: "unknown", code: "app_server_incompatible",
    stage: "qualification", reason: "qualification_record_missing",
  });
  assert.deepEqual(persisted.at(-1).error, result.error);
  assert.equal(JSON.stringify([result, persisted]).includes(SECRET), false);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture({ run, millisecondsPerMinute = 60_000, maxAccumulatedOutputBytes } = {}) {
  const persisted = [];
  const runtimeCalls = [];
  const validateRequest = (request) => validateGeminiRequest(request, {
    permittedWorkspaceRoots: ["D:\\Repo"],
    realpathPath: async () => "D:\\Repo",
    statPath: async () => ({ isDirectory: () => true }),
  });
  const core = createGeminiCompanionCore({
    validateRequest,
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [{ code: "version_changed" }] }) },
    workspaceLeases: createWorkspaceLeaseManager(),
    createRuntime: async (context) => {
      runtimeCalls.push(context);
      return {
        run: run ?? (async () => ({
          sessionId: "session_1",
          finalAnswer: `done ${SECRET}`,
          filesChanged: ["src/a.js"],
          tests: [{ command: "npm test", status: "passed", authorization: SECRET }],
        })),
        cancel: async () => {},
        dispose: async () => {},
      };
    },
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    persistStatus: async (status) => persisted.push(structuredClone(status)),
    generateJobId: () => "job_1",
    millisecondsPerMinute,
    ...(maxAccumulatedOutputBytes === undefined ? {} : { maxAccumulatedOutputBytes }),
  });
  return { core, persisted, runtimeCalls };
}

function lifecycleCore(overrides = {}) {
  let nextId = 0;
  return createGeminiCompanionCore({
    validateRequest: async (request) => ({
      task: request.task,
      workspace: request.workspace,
      effort: request.effort ?? "medium",
      access: request.access ?? "read-only",
      timeoutMinutes: request.timeout_minutes ?? 30,
    }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(),
    createRuntime: async () => ({
      run: async () => ({ finalAnswer: "done", filesChanged: [], tests: [] }),
      cancel: async () => {},
      dispose: async () => {},
    }),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => `job_${++nextId}`,
    cleanupTimeoutMs: 10,
    persistenceTimeoutMs: 10,
    ...overrides,
  });
}

async function settlesWithin(promise, timeoutMs = 100) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    timeout,
  ]);
  clearTimeout(timer);
  return result;
}

test("runs the offline core and persists only bounded sanitized status", async () => {
  const { core, persisted, runtimeCalls } = fixture();
  const result = await core.runGeminiTask(baseRequest);

  assert.equal(result.status, "completed");
  assert.equal(result.finalAnswer, "done [REDACTED]");
  assert.equal(result.tests[0].authorization, "[REDACTED]");
  assert.equal(result.sessionId, "session_1");
  assert.equal(JSON.stringify(persisted).includes(SECRET), false);
  assert.deepEqual(persisted.map((entry) => entry.status), ["starting", "running", "completed"]);
  assert.equal(runtimeCalls[0].request.effort, "medium");
  assert.equal(runtimeCalls[0].request.access, "read-only");
  assert.equal(Object.hasOwn(runtimeCalls[0], "providerUrl"), false);
  assert.deepEqual(core.getGeminiStatus("job_1"), result);

  result.status = "tampered";
  assert.equal(core.getGeminiStatus("job_1").status, "completed");
});

test("enforces the writer lease across concurrent jobs", async () => {
  const pending = deferred();
  let nextId = 0;
  const leases = createWorkspaceLeaseManager();
  const core = createGeminiCompanionCore({
    validateRequest: (request) => validateGeminiRequest(request, {
      permittedWorkspaceRoots: ["D:\\Repo"],
      realpathPath: async () => "D:\\Repo",
      statPath: async () => ({ isDirectory: () => true }),
    }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: leases,
    createRuntime: async () => ({ run: () => pending.promise, cancel: async () => {}, dispose: async () => {} }),
    redactor: createCompanionRedactor(),
    generateJobId: () => `job_${++nextId}`,
  });

  const first = core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  assert.equal(second.status, "failed");
  assert.equal(second.error.category, "workspace_locked");
  pending.resolve({ finalAnswer: "done", filesChanged: [], tests: [] });
  assert.equal((await first).status, "completed");
});

test("cancels an active job and releases its runtime and writer lease", async () => {
  const pending = deferred();
  let cancelCalls = 0;
  let disposeCalls = 0;
  const { core } = fixture({
    run: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      pending.promise.then(resolve, reject);
    }),
  });
  // Replace the runtime factory through a dedicated instance so cleanup counts are observable.
  const cancellable = createGeminiCompanionCore({
    validateRequest: (request) => validateGeminiRequest(request, {
      permittedWorkspaceRoots: ["D:\\Repo"],
      realpathPath: async () => "D:\\Repo",
      statPath: async () => ({ isDirectory: () => true }),
    }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(),
    createRuntime: async () => ({
      run: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(SECRET)), { once: true })),
      cancel: async () => { cancelCalls += 1; },
      dispose: async () => { disposeCalls += 1; },
    }),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => "job_1",
  });
  const running = cancellable.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await cancellable.cancelGeminiTask("job_1")).status, "cancelled");
  assert.equal((await running).status, "cancelled");
  assert.equal(cancelCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.equal(JSON.stringify(cancellable.getGeminiStatus("job_1")).includes(SECRET), false);
  assert.throws(() => core.getGeminiStatus("missing"), { code: "job_not_found" });
});

test("times out, cancels the runtime, and returns a typed recovery category", async () => {
  let cancelCalls = 0;
  const core = createGeminiCompanionCore({
    validateRequest: (request) => validateGeminiRequest(request, {
      permittedWorkspaceRoots: ["D:\\Repo"],
      realpathPath: async () => "D:\\Repo",
      statPath: async () => ({ isDirectory: () => true }),
    }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(),
    createRuntime: async () => ({
      run: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(SECRET)), { once: true })),
      cancel: async () => { cancelCalls += 1; },
      dispose: async () => {},
    }),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => "job_1",
    millisecondsPerMinute: 1,
  });
  const result = await core.runGeminiTask({ ...baseRequest, timeout_minutes: 1 });
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "timeout");
  assert.equal(cancelCalls, 1);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("does not acquire a lease or create a runtime when compatibility fails", async () => {
  const calls = [];
  const core = createGeminiCompanionCore({
    validateRequest: async (request) => { calls.push("validate"); return { ...request, effort: "medium", access: "read-only", timeoutMinutes: 30 }; },
    compatibilityAdapter: { check: async () => { calls.push("compatibility"); throw Object.assign(new Error(SECRET), { code: "app_server_incompatible" }); } },
    workspaceLeases: { acquire: async () => { calls.push("lease"); return { release: async () => {} }; } },
    createRuntime: async () => { calls.push("runtime"); return { run: async () => ({}) }; },
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => "job_1",
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.deepEqual(calls, ["validate", "compatibility"]);
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "app_server_incompatible");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("resume context attached during runtime preparation reaches workspace preparation", async () => {
  // The validated request is frozen at the validation boundary; the runtime
  // preparation attaches request.resumeContext for session resume and the
  // workspace manager must still observe it (job.request stays extensible).
  let preparedRequest;
  let workspaceRequest;
  const core = createGeminiCompanionCore({
    validateRequest: async () => Object.freeze({
      task: "x", workspace: "D:\\Repo", effort: "medium", access: "read-only", timeoutMinutes: 30, sessionId: "sess_1",
    }),
    prepareRuntime: async ({ request }) => {
      request.resumeContext = { executionWorkspace: request.workspace, worktreePath: null, head: null };
      preparedRequest = request;
      return {
        compatibility: { status: "compatible", warnings: [] },
        run: async () => ({ finalAnswer: "ok", filesChanged: [], tests: [] }),
        cancel: async () => {},
        dispose: async () => {},
      };
    },
    workspaceManager: {
      prepare: async (request) => {
        workspaceRequest = request;
        return { executionWorkspace: request.workspace, worktreePath: null, head: null };
      },
    },
    workspaceLeases: createWorkspaceLeaseManager(),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => "job_1",
  });
  const result = await core.runGeminiTask({ ...baseRequest, sessionId: "sess_1" });
  assert.equal(result.status, "completed");
  assert.equal(preparedRequest.resumeContext?.executionWorkspace, "D:\\Repo");
  assert.equal(workspaceRequest.resumeContext?.executionWorkspace, "D:\\Repo");
});

test("publishes approval state, bounds output, and ignores events after completion", async () => {
  let releaseRuntime;
  const hold = new Promise((resolve) => { releaseRuntime = resolve; });
  let emitLate;
  const { core } = fixture({
    maxAccumulatedOutputBytes: 4,
    run: async ({ onEvent }) => {
      await onEvent({ type: "approval_required", approval: { command: `echo ${SECRET}`, authorization: SECRET } });
      emitLate = onEvent;
      await hold;
      await onEvent({ type: "assistant_delta", text: "abcdef" });
      return { finalAnswer: "ok", filesChanged: [], tests: [] };
    },
  });
  const running = core.runGeminiTask(baseRequest);
  await new Promise((resolve) => setImmediate(resolve));
  const awaiting = core.getGeminiStatus("job_1");
  assert.equal(awaiting.status, "awaiting_approval");
  assert.equal(JSON.stringify(awaiting).includes(SECRET), false);
  releaseRuntime();
  const completed = await running;
  assert.equal(completed.status, "completed");
  assert.equal(completed.output, "abcd");
  assert.equal(Object.hasOwn(completed, "approval"), false);
  await emitLate({ type: "assistant_delta", text: SECRET });
  assert.deepEqual(core.getGeminiStatus("job_1"), completed);
});

test("uses the idle deadline independently from the hard timeout", async () => {
  let cancelCalls = 0;
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({ task: "x", workspace: "D:\\Repo", effort: "medium", access: "read-only", timeoutMinutes: 100 }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(),
    createRuntime: async () => ({
      run: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(SECRET)), { once: true })),
      cancel: async () => { cancelCalls += 1; },
      dispose: async () => {},
    }),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => "job_1",
    idleTimeoutMs: 5,
    millisecondsPerMinute: 10,
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(result.error.category, "timeout");
  assert.equal(cancelCalls, 1);
});

test("turns hostile runtime results into sanitized failures and releases resources once", async () => {
  let releaseCalls = 0;
  let disposeCalls = 0;
  const hostileResult = {};
  Object.defineProperty(hostileResult, "finalAnswer", {
    enumerable: true,
    get() { throw new Error(SECRET); },
  });
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({ task: "x", workspace: "D:\\Repo", effort: "medium", access: "workspace-write", timeoutMinutes: 30 }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: { acquire: async () => ({ release: async () => { releaseCalls += 1; } }) },
    createRuntime: async () => ({
      run: async () => hostileResult,
      cancel: async () => {},
      dispose: async () => { disposeCalls += 1; },
    }),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => "job_1",
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "protocol_error");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(disposeCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("converts an oversized runtime result into a bounded typed failure", async () => {
  const { core } = fixture({
    run: async () => ({ finalAnswer: "x".repeat(64 * 1024 + 1), filesChanged: [], tests: [] }),
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "protocol_error");
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 256 * 1024);
});

test("sanitizes hostile runtime Error accessors instead of escaping lifecycle cleanup", async () => {
  let disposeCalls = 0;
  const hostile = new Error("safe");
  Object.defineProperty(hostile, "code", {
    get() { throw new Error(SECRET); },
  });
  const counted = createGeminiCompanionCore({
    validateRequest: async () => ({ task: "x", workspace: "D:\\Repo", effort: "medium", access: "read-only", timeoutMinutes: 30 }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(),
    createRuntime: async () => ({
      run: async () => { throw hostile; },
      cancel: async () => {},
      dispose: async () => { disposeCalls += 1; },
    }),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    generateJobId: () => "job_1",
  });
  const result = await counted.runGeminiTask(baseRequest);
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "protocol_error");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(disposeCalls, 1);
});

test("redacts the generated identifier before the starting snapshot is persisted", async () => {
  const persisted = [];
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({ task: "x", workspace: "D:\\Repo", effort: "medium", access: "read-only", timeoutMinutes: 30 }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(),
    createRuntime: async () => ({
      run: async () => ({ finalAnswer: "done", filesChanged: [], tests: [] }),
      dispose: async () => {},
    }),
    redactor: createCompanionRedactor({ knownSecrets: [SECRET] }),
    persistStatus: async (status) => persisted.push(status),
    generateJobId: () => `job_${SECRET}`,
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(JSON.stringify(persisted).includes(SECRET), false);
  assert.equal(result.jobId, "job_[REDACTED]");
  assert.equal(core.getGeminiStatus(result.jobId).status, "completed");
});

test("truncates a large event in linear bounded space without failing the job", async () => {
  const { core } = fixture({
    run: async ({ onEvent }) => {
      await onEvent({ type: "assistant_delta", text: `${"x".repeat(70 * 1024)}🙂` });
      return { finalAnswer: "done", filesChanged: [], tests: [] };
    },
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(result.status, "completed");
  assert.equal(Buffer.byteLength(result.output, "utf8"), 32 * 1024);
  assert.equal(result.output.includes("�"), false);
});

test("redacts a complete delta before applying the accumulated output limit", async () => {
  const { core } = fixture({
    maxAccumulatedOutputBytes: 16,
    run: async ({ onEvent }) => {
      await onEvent({ type: "assistant_delta", text: SECRET });
      return { finalAnswer: "done", filesChanged: [], tests: [] };
    },
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "[REDACTED]");
  assert.equal(SECRET.startsWith(result.output), false);
});

test("cancellation wins while compatibility is pending", async () => {
  const compatibility = deferred();
  let leaseCalls = 0;
  let runtimeCalls = 0;
  const core = lifecycleCore({
    compatibilityAdapter: { check: () => compatibility.promise },
    workspaceLeases: { acquire: async () => { leaseCalls += 1; return { release: async () => {} }; } },
    createRuntime: async () => { runtimeCalls += 1; return { run: async () => ({}) }; },
    generateJobId: () => "job_compatibility",
  });
  const running = core.runGeminiTask(baseRequest);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await settlesWithin(core.cancelGeminiTask("job_compatibility"));
  const runOutcome = await settlesWithin(running);
  assert.equal(cancelled.timedOut, undefined);
  assert.equal(cancelled.value.status, "cancelled");
  assert.equal(runOutcome.timedOut, undefined);
  assert.equal(runOutcome.value.status, "cancelled");
  assert.equal(leaseCalls, 0);
  assert.equal(runtimeCalls, 0);
  compatibility.resolve({ status: "compatible", warnings: [] });
});

test("cancellation wins while validation is pending", async () => {
  const validation = deferred();
  let compatibilityCalls = 0;
  const core = lifecycleCore({
    validateRequest: () => validation.promise,
    compatibilityAdapter: { check: async () => { compatibilityCalls += 1; return { status: "compatible", warnings: [] }; } },
    generateJobId: () => "job_validation",
  });
  const running = core.runGeminiTask(baseRequest);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await settlesWithin(core.cancelGeminiTask("job_validation"));
  assert.equal(cancelled.timedOut, undefined);
  assert.equal(cancelled.value.status, "cancelled");
  assert.equal((await settlesWithin(running)).value.status, "cancelled");
  assert.equal(compatibilityCalls, 0);
  validation.resolve({ ...baseRequest, effort: "medium", access: "read-only", timeoutMinutes: 30 });
});

test("hard timeout covers compatibility setup after validation", async () => {
  const core = lifecycleCore({
    compatibilityAdapter: { check: () => new Promise(() => {}) },
    generateJobId: () => "job_timeout_setup",
    millisecondsPerMinute: 1,
  });
  const result = await settlesWithin(core.runGeminiTask({ ...baseRequest, timeout_minutes: 1 }));
  assert.equal(result.timedOut, undefined);
  assert.equal(result.value.status, "failed");
  assert.equal(result.value.error.category, "timeout");
});

test("reclaims a runtime that resolves after cancellation", async () => {
  const runtimeStage = deferred();
  const calls = [];
  const core = lifecycleCore({
    workspaceLeases: {
      acquire: async () => ({ release: async () => calls.push("release") }),
    },
    createRuntime: () => runtimeStage.promise,
    generateJobId: () => "job_late_runtime",
  });
  const running = core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await settlesWithin(core.cancelGeminiTask("job_late_runtime"));
  assert.equal(cancelled.timedOut, undefined);
  assert.equal(cancelled.value.status, "cancelled");
  runtimeStage.resolve({
    run: async () => ({ finalAnswer: "late", filesChanged: [], tests: [] }),
    cancel: async () => calls.push("cancel"),
    dispose: async () => calls.push("dispose"),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(calls, ["cancel", "dispose", "release"]);
  assert.equal((await settlesWithin(running)).value.status, "cancelled");
});

test("releases a writer lease that resolves after cancellation exactly once", async () => {
  const leaseStage = deferred();
  let releaseCalls = 0;
  let runtimeCalls = 0;
  const core = lifecycleCore({
    workspaceLeases: { acquire: () => leaseStage.promise },
    createRuntime: async () => { runtimeCalls += 1; return { run: async () => ({}) }; },
    generateJobId: () => "job_late_lease",
  });
  const running = core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await settlesWithin(core.cancelGeminiTask("job_late_lease"));
  assert.equal(cancelled.timedOut, undefined);
  assert.equal(cancelled.value.status, "cancelled");
  leaseStage.resolve({ release: async () => { releaseCalls += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(releaseCalls, 1);
  assert.equal(runtimeCalls, 0);
  assert.equal((await settlesWithin(running)).value.status, "cancelled");
  assert.equal((await core.cancelGeminiTask("job_late_lease")).status, "cancelled");
  assert.equal(releaseCalls, 1);
});

test("awaits interrupt before dispose and bounds a hung interrupt", async () => {
  const cancelGate = deferred();
  const calls = [];
  const core = lifecycleCore({
    workspaceLeases: {
      acquire: async () => ({ release: async () => calls.push("release") }),
    },
    createRuntime: async () => ({
      run: () => new Promise(() => {}),
      cancel: async () => { calls.push("cancel-start"); await cancelGate.promise; calls.push("cancel-end"); },
      dispose: async () => calls.push("dispose"),
    }),
    generateJobId: () => "job_interrupt_order",
    cleanupTimeoutMs: 10,
  });
  const running = core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await settlesWithin(core.cancelGeminiTask("job_interrupt_order"));
  assert.equal(cancelled.value.status, "cancelled");
  assert.deepEqual(calls, ["cancel-start", "dispose"]);
  cancelGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["cancel-start", "dispose", "cancel-end"]);
  assert.equal((await running).status, "cancelled");
});

test("keeps the writer lease when runtime disposal cannot be confirmed", async () => {
  const leases = createWorkspaceLeaseManager();
  const request = { ...baseRequest, access: "workspace-write", effort: "medium", timeoutMinutes: 30 };
  const core = lifecycleCore({
    workspaceLeases: leases,
    createRuntime: async () => ({
      run: async () => ({ finalAnswer: "done", filesChanged: [], tests: [] }),
      dispose: () => new Promise(() => {}),
    }),
    generateJobId: () => "job_unconfirmed_dispose",
    cleanupTimeoutMs: 10,
  });
  const result = await core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "protocol_error");

  const blocked = await leaseOutcome(leases, request);
  if (blocked.lease) await blocked.lease.release();
  assert.equal(blocked.error?.code, "workspace_locked");
});

test("releases the writer lease when cancel fails but runtime disposal succeeds", async () => {
  const leases = createWorkspaceLeaseManager();
  const request = { ...baseRequest, access: "workspace-write", effort: "medium", timeoutMinutes: 30 };
  const calls = [];
  const core = lifecycleCore({
    workspaceLeases: leases,
    createRuntime: async () => ({
      run: async () => { throw new Error("turn failed"); },
      cancel: async () => { calls.push("cancel"); throw new Error("already closed"); },
      dispose: async () => calls.push("dispose"),
    }),
    generateJobId: () => "job_cancel_failed_disposed",
  });

  const result = await core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, ["cancel", "dispose"]);
  const available = await leases.acquire(request);
  await available.release();
});

test("contains persistence failures at starting, running, and terminal snapshots", async () => {
  for (const failAt of [1, 2, 3]) {
    let persistCalls = 0;
    let disposeCalls = 0;
    const core = lifecycleCore({
      persistStatus: async () => {
        persistCalls += 1;
        if (persistCalls >= failAt) throw new Error(`raw-persistence-secret ${SECRET}`);
      },
      createRuntime: async () => ({
        run: async () => ({ finalAnswer: "done", filesChanged: [], tests: [] }),
        cancel: async () => {},
        dispose: async () => { disposeCalls += 1; },
      }),
      generateJobId: () => `job_persist_${failAt}`,
    });
    const outcome = await settlesWithin(core.runGeminiTask(baseRequest));
    assert.equal(outcome.timedOut, undefined);
    assert.equal(outcome.value.status, "failed");
    assert.equal(outcome.value.error.category, "protocol_error");
    assert.equal(JSON.stringify(outcome.value).includes("raw-persistence-secret"), false);
    assert.deepEqual(core.getGeminiStatus(`job_persist_${failAt}`), outcome.value);
    assert.ok(persistCalls <= failAt);
    assert.ok(disposeCalls <= 1);
  }
});

test("bounds a hung terminal persistence write and resolves run and cancellation", async () => {
  const terminalPersistStarted = deferred();
  let persistCalls = 0;
  const core = lifecycleCore({
    persistStatus: async () => {
      persistCalls += 1;
      if (persistCalls === 3) {
        terminalPersistStarted.resolve();
        return new Promise(() => {});
      }
    },
    generateJobId: () => "job_hung_terminal_persist",
    persistenceTimeoutMs: 10,
  });
  const running = core.runGeminiTask(baseRequest);
  await terminalPersistStarted.promise;
  const cancelling = core.cancelGeminiTask("job_hung_terminal_persist");
  const [runOutcome, cancelOutcome] = await Promise.all([
    settlesWithin(running),
    settlesWithin(cancelling),
  ]);
  assert.equal(runOutcome.timedOut, undefined);
  assert.equal(cancelOutcome.timedOut, undefined);
  assert.equal(runOutcome.value.status, "failed");
  assert.equal(cancelOutcome.value.status, "failed");
  assert.equal(runOutcome.value.error.category, "protocol_error");
  assert.deepEqual(core.getGeminiStatus("job_hung_terminal_persist"), runOutcome.value);
  assert.equal(persistCalls, 3);
});

async function leaseOutcome(leases, request) {
  try {
    return { lease: await leases.acquire(request) };
  } catch (error) {
    return { error };
  }
}

test("holds a writer lease until an abandoned runtime resolves and is cleaned", async () => {
  const runtimeStage = deferred();
  const factoryStarted = deferred();
  const runtimeDisposed = deferred();
  const leases = createWorkspaceLeaseManager();
  let cancelCalls = 0;
  let disposeCalls = 0;
  const request = { ...baseRequest, access: "workspace-write", effort: "medium", timeoutMinutes: 30 };
  const core = lifecycleCore({
    workspaceLeases: leases,
    createRuntime: () => {
      factoryStarted.resolve();
      return runtimeStage.promise;
    },
    generateJobId: () => "job_hold_late_runtime",
  });
  const running = core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await factoryStarted.promise;
  assert.equal((await core.cancelGeminiTask("job_hold_late_runtime")).status, "cancelled");

  const blocked = await leaseOutcome(leases, request);
  if (blocked.lease) await blocked.lease.release();
  assert.equal(blocked.error?.code, "workspace_locked");

  runtimeStage.resolve({
    run: async () => ({ finalAnswer: "late", filesChanged: [], tests: [] }),
    cancel: async () => { cancelCalls += 1; },
    dispose: async () => { disposeCalls += 1; runtimeDisposed.resolve(); },
  });
  await runtimeDisposed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const available = await leases.acquire(request);
  await available.release();
  assert.equal(cancelCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.equal((await running).status, "cancelled");
});

test("holds a writer lease until an abandoned runtime rejects", async () => {
  const runtimeStage = deferred();
  const factoryStarted = deferred();
  const leases = createWorkspaceLeaseManager();
  const request = { ...baseRequest, access: "workspace-write", effort: "medium", timeoutMinutes: 30 };
  const core = lifecycleCore({
    workspaceLeases: leases,
    createRuntime: () => {
      factoryStarted.resolve();
      return runtimeStage.promise;
    },
    generateJobId: () => "job_hold_late_rejection",
  });
  const running = core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await factoryStarted.promise;
  assert.equal((await core.cancelGeminiTask("job_hold_late_rejection")).status, "cancelled");

  const blocked = await leaseOutcome(leases, request);
  if (blocked.lease) await blocked.lease.release();
  assert.equal(blocked.error?.code, "workspace_locked");

  runtimeStage.reject(new Error(`late ${SECRET}`));
  await new Promise((resolve) => setImmediate(resolve));
  const available = await leases.acquire(request);
  await available.release();
  assert.equal((await running).status, "cancelled");
});

test("keeps a transferred writer lease when late runtime cleanup cannot be confirmed", async () => {
  const runtimeStage = deferred();
  const factoryStarted = deferred();
  const leases = createWorkspaceLeaseManager();
  const request = { ...baseRequest, access: "workspace-write", effort: "medium", timeoutMinutes: 30 };
  const core = lifecycleCore({
    workspaceLeases: leases,
    createRuntime: () => {
      factoryStarted.resolve();
      return runtimeStage.promise;
    },
    generateJobId: () => "job_hold_failed_late_cleanup",
    cleanupTimeoutMs: 10,
  });
  const running = core.runGeminiTask({ ...baseRequest, access: "workspace-write" });
  await factoryStarted.promise;
  assert.equal((await core.cancelGeminiTask("job_hold_failed_late_cleanup")).status, "cancelled");

  runtimeStage.resolve({
    run: async () => ({ finalAnswer: "late", filesChanged: [], tests: [] }),
    cancel: async () => {},
    dispose: () => new Promise(() => {}),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const blocked = await leaseOutcome(leases, request);
  if (blocked.lease) await blocked.lease.release();
  assert.equal(blocked.error?.code, "workspace_locked");
  assert.equal((await running).status, "cancelled");
});

test("redacts split secret deltas before accumulation and terminal scrubbing", async () => {
  const persisted = [];
  const core = lifecycleCore({
    persistStatus: async (snapshot) => persisted.push(snapshot),
    createRuntime: async () => ({
      run: async ({ onEvent }) => {
        await onEvent({ type: "assistant_delta", text: "sentinel-runtime-" });
        await onEvent({ type: "assistant_delta", text: "secret" });
        return { finalAnswer: "done", filesChanged: [], tests: [] };
      },
      cancel: async () => {},
      dispose: async () => {},
    }),
    generateJobId: () => "job_split_secret",
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(JSON.stringify(persisted).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.output, "[REDACTED]");
});

test("rejects malformed and oversized runtime results", async () => {
  const invalidResults = [
    null,
    { finalAnswer: {}, filesChanged: [], tests: [] },
    { finalAnswer: "done", filesChanged: "src/a.js", tests: [] },
    { finalAnswer: "done", filesChanged: [], tests: "passed" },
    { finalAnswer: "done", filesChanged: [], tests: [], sessionId: "x".repeat(513) },
    { finalAnswer: "done", filesChanged: [], tests: [], unknown: true },
    { finalAnswer: "done", filesChanged: ["x".repeat(4_097)], tests: [] },
    { finalAnswer: "done", filesChanged: [], tests: ["x".repeat(16 * 1_024 + 1)] },
    { finalAnswer: "done", filesChanged: [], tests: [[]] },
  ];
  for (let index = 0; index < invalidResults.length; index += 1) {
    const core = lifecycleCore({
      createRuntime: async () => ({
        run: async () => invalidResults[index],
        cancel: async () => {},
        dispose: async () => {},
      }),
      generateJobId: () => `job_invalid_${index}`,
    });
    const result = await core.runGeminiTask(baseRequest);
    assert.equal(result.status, "failed");
    assert.equal(result.error.category, "protocol_error");
  }
});

test("does not acquire workspace leases for read-only jobs", async () => {
  let leaseCalls = 0;
  const core = lifecycleCore({
    workspaceLeases: { acquire: async () => { leaseCalls += 1; throw new Error("must not run"); } },
    generateJobId: () => "job_read_only",
  });
  assert.equal((await core.runGeminiTask(baseRequest)).status, "completed");
  assert.equal(leaseCalls, 0);
});

test("creates an immutable read grant without requesting approval", async () => {
  let grant;
  let decisions = 0;
  const resolvedScope = Object.freeze({
    workspace: "D:\\Repo",
    access: "read-only",
    read: Object.freeze([Object.freeze({ absolutePath: "D:\\Repo\\src", relativePath: "src", kind: "directory", identity: null })]),
    write: Object.freeze([]),
    allowCreate: false,
    protectedRoots: Object.freeze([]),
    summary: { workspace: "D:\\Repo", read: [{ path: "src", kind: "directory" }], write: [], allow_create: false },
  });
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({
      task: "inspect source", workspace: "D:\\Repo", effort: "medium", access: "read-only",
      scoped: true, timeoutMinutes: 30, runtimeFingerprint: "router-responses-v1", resolvedScope,
    }),
    prepareRuntime: async ({ grant: value }) => {
      grant = value;
      assert.equal(Object.isFrozen(value), true);
      return {
        compatibility: { status: "compatible", warnings: [] },
        run: async () => ({ finalAnswer: "read", filesChanged: [], tests: [] }),
        dispose: async () => {},
      };
    },
    workspaceLeases: { acquire: async () => { throw new Error("read-only must not lease"); } },
    redactor: createCompanionRedactor(), generateJobId: () => "job_read_grant",
  });
  const result = await core.runGeminiTask({ task: "inspect source", workspace: "D:\\Repo" }, {
    requestDecision: async () => { decisions += 1; return "accept"; },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.filesChanged, []);
  assert.equal(decisions, 0);
  assert.equal(typeof grant.scopeHash, "string");
  assert.equal(Object.isFrozen(grant.read), true);
});

test("bridges a write intent through awaiting approval and resumes without a preflight grant decision", async () => {
  const persisted = [];
  const decisions = [];
  const gate = deferred();
  const core = lifecycleCore({
    persistStatus: async (status) => persisted.push(structuredClone(status)),
    createRuntime: async () => ({
      run: async ({ onEvent, requestDecision }) => {
        await onEvent({ type: "write_intent", approval: {
          type: "write_intent", operation: "replace_text", path: "src\\auth.js",
          expectedSha256: "a".repeat(64), operationFingerprint: "b".repeat(64), deadline: Date.now() + 10_000,
        } });
        decisions.push(await requestDecision({ type: "write_intent" }));
        gate.resolve();
        return { finalAnswer: "done", filesChanged: [], tests: [] };
      }, cancel: async () => {}, dispose: async () => {},
    }),
  });
  const run = core.runGeminiTask({ ...baseRequest, access: "workspace-write" }, {
    requestDecision: async () => "accept",
  });
  await gate.promise;
  const statuses = persisted.map((status) => status.status);
  assert.ok(statuses.includes("awaiting_approval"));
  assert.deepEqual(decisions, ["accept"]);
  assert.equal((await run).status, "completed");
});

test("qualifies one prepared runtime before writer mutation and reuses it for the turn", async () => {
  const calls = [];
  const prepared = {
    compatibility: { status: "compatible", warnings: [] },
    run: async ({ executionWorkspace }) => {
      calls.push(["run", executionWorkspace]);
      return { finalAnswer: "done", filesChanged: [], tests: [] };
    },
    dispose: async () => calls.push("dispose"),
  };
  const core = createGeminiCompanionCore({
    validateRequest: async () => {
      calls.push("validate");
      return { task: "x", workspace: "D:\\Repo", effort: "medium", access: "workspace-write", timeoutMinutes: 30 };
    },
    prepareRuntime: async () => { calls.push("prepare-runtime"); return prepared; },
    workspaceLeases: { acquire: async () => { calls.push("lease"); return { release: async () => calls.push("release") }; } },
    workspaceManager: { prepare: async () => { calls.push("worktree"); return { executionWorkspace: "C:\\jobs\\job_1", worktreePath: "C:\\jobs\\job_1", head: "a".repeat(40) }; } },
    redactor: createCompanionRedactor(),
    generateJobId: () => "job_1",
  });
  const result = await core.runGeminiTask(baseRequest);
  assert.equal(result.status, "completed");
  assert.equal(result.worktreePath, "C:\\jobs\\job_1");
  assert.deepEqual(calls, ["validate", "prepare-runtime", "lease", "worktree", ["run", "C:\\jobs\\job_1"], "dispose", "release"]);
});

test("cleans a prepared runtime cancelled before a writer claim and never mutates workspace", async () => {
  const stage = deferred();
  const calls = [];
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({ task: "x", workspace: "D:\\Repo", effort: "medium", access: "workspace-write", timeoutMinutes: 30 }),
    prepareRuntime: () => stage.promise,
    workspaceLeases: { acquire: async () => { calls.push("lease"); return { release: async () => {} }; } },
    workspaceManager: { prepare: async () => { calls.push("worktree"); return {}; } },
    redactor: createCompanionRedactor(), generateJobId: () => "job_prepared_cancel", cleanupTimeoutMs: 20,
  });
  const running = core.runGeminiTask(baseRequest);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await core.cancelGeminiTask("job_prepared_cancel")).status, "cancelled");
  stage.resolve({
    compatibility: { status: "compatible", warnings: [] }, run: async () => ({}),
    cancel: async () => calls.push("cancel"), dispose: async () => calls.push("dispose"),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(calls, ["cancel", "dispose"]);
  assert.equal((await running).status, "cancelled");
});

test("loads only terminal recovered statuses for on-demand inspection", () => {
  const recovered = { jobId: "job_recovered", status: "failed", worktreePath: "C:\\jobs\\job_recovered", error: { category: "protocol_error" } };
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({}), prepareRuntime: async () => ({ run: async () => ({}) }),
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(),
    initialStatuses: [recovered],
  });
  assert.deepEqual(core.getGeminiStatus("job_recovered"), {
    ...recovered, error: { category: "protocol_error", source: "unknown" },
  });
});

test("locks writers by canonical Git repository rather than selected subdirectory", async () => {
  const pending = deferred();
  let nextId = 0;
  const core = createGeminiCompanionCore({
    validateRequest: async (request) => ({ ...request, effort: "medium", access: "workspace-write", timeoutMinutes: 30 }),
    prepareRuntime: async ({ jobId }) => ({
      compatibility: { status: "compatible", warnings: [] },
      run: jobId === "job_1" ? () => pending.promise : async () => ({ finalAnswer: "unexpected", filesChanged: [], tests: [] }),
      dispose: async () => {},
    }),
    workspaceLeases: createWorkspaceLeaseManager(),
    workspaceManager: {
      resolveRepository: async () => ({ repositoryRoot: "D:\\Repo" }),
      prepare: async (_request, jobId) => ({ executionWorkspace: `C:\\jobs\\${jobId}`, worktreePath: `C:\\jobs\\${jobId}`, head: "a".repeat(40) }),
    },
    redactor: createCompanionRedactor(), generateJobId: () => `job_${++nextId}`,
  });
  const first = core.runGeminiTask({ task: "one", workspace: "D:\\Repo" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await core.runGeminiTask({ task: "two", workspace: "D:\\Repo\\packages\\app" });
  assert.equal(second.status, "failed");
  assert.equal(second.error.category, "workspace_locked");
  pending.resolve({ finalAnswer: "done", filesChanged: [], tests: [] });
  assert.equal((await first).status, "completed");
});

test("cancels a failed active turn before disposing its runtime", async () => {
  const calls = [];
  const failure = Object.assign(new Error("approval failed"), { code: "app_server_approval_error" });
  const core = lifecycleCore({
    createRuntime: async () => ({
      run: async () => { throw failure; },
      cancel: async () => calls.push("cancel"),
      dispose: async () => calls.push("dispose"),
    }),
    generateJobId: () => "job_approval_cleanup",
  });
  assert.equal((await core.runGeminiTask(baseRequest)).status, "failed");
  assert.deepEqual(calls, ["cancel", "dispose"]);
});

test("fails closed on an invalid scoped grant and never launches the prepared runtime", async () => {
  let prepareCalls = 0;
  const core = lifecycleCore({
    validateRequest: async (request) => ({
      task: request.task, workspace: request.workspace, effort: "medium", access: "read-only",
      timeoutMinutes: 30, scoped: true, runtimeFingerprint: "router-responses-v1",
      resolvedScope: Object.freeze({ workspace: request.workspace, access: "read-only" }),
    }),
    resolveScopedRuntimeFingerprint: async () => "router-responses-v1",
    createScopedGrant: () => ({ jobId: "forged" }),
    prepareRuntime: async () => { prepareCalls += 1; throw new Error("prepared runtime must not launch"); },
  });
  const result = await core.runGeminiTask({ task: "inspect", workspace: "D:\Repo" });
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "protocol_error");
  assert.equal(prepareCalls, 0);
});
