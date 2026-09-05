import test from "node:test";
import assert from "node:assert/strict";

import { createGeminiCompanionCore } from "../src/core.js";
import { createCompanionRedactor } from "../src/redaction.js";
import { validateGeminiRequest } from "../src/request.js";
import { createWorkspaceLeaseManager } from "../src/workspace-lease.js";

const SECRET = "sentinel-runtime-secret";
const baseRequest = { task: "inspect", workspace: "D:\\Repo" };

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
