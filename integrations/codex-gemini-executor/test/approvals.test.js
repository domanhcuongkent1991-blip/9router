import test from "node:test";
import assert from "node:assert/strict";

import { AppServerCompatibilityError } from "../src/app-server/compatibility.js";
import {
  AppServerApprovalError,
  createAppServerApprovalAdapter,
} from "../src/app-server/approvals.js";

const activeTurn = Object.freeze({ jobId: "job_1", threadId: "thr_1", turnId: "turn_1" });

function commandMessage(overrides = {}) {
  const defaultParams = {
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "item_1",
    command: "SECRET command",
    cwd: "C:\\SECRET\\work",
    reason: "SECRET reason",
  };
  return {
    method: "item/commandExecution/requestApproval",
    id: "request_1",
    params: Object.hasOwn(overrides, "params") && overrides.params === null
      ? null
      : { ...defaultParams, ...overrides.params },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "params")),
  };
}

function fileMessage(overrides = {}) {
  return {
    method: "item/fileChange/requestApproval",
    id: 7,
    params: {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_2",
      reason: "SECRET file reason",
      grantRoot: null,
      ...overrides.params,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "params")),
  };
}

function adapterFixture({ decision = "accept", respond, requestDecision, sanitizeForDisplay, timeoutMs = 100 } = {}) {
  const responses = [];
  const prompts = [];
  const sanitizeCalls = [];
  const adapter = createAppServerApprovalAdapter({
    respond: respond ?? (async (id, result) => responses.push({ id, result })),
    requestDecision: requestDecision ?? (async (prompt) => {
      prompts.push(prompt);
      return decision;
    }),
    sanitizeForDisplay: sanitizeForDisplay ?? ((value) => {
      sanitizeCalls.push(value);
      return value === null ? null : "<redacted>";
    }),
    timeoutMs,
  });
  return { adapter, responses, prompts, sanitizeCalls };
}

function assertSanitizedApprovalError(error, reason, stage) {
  assert.ok(error instanceof AppServerApprovalError);
  assert.equal(error.code, "app_server_approval_error");
  assert.equal(error.details.reason, reason);
  assert.equal(error.details.stage, stage);
  assert.ok(Object.keys(error.details).every((key) => ["reason", "stage", "causeType"].includes(key)));
  assert.equal(JSON.stringify(error).includes("SECRET"), false);
  return true;
}

test("relays only the three explicit command decisions once", async () => {
  for (const decision of ["accept", "decline", "cancel"]) {
    const { adapter, responses, prompts, sanitizeCalls } = adapterFixture({ decision });
    assert.deepEqual(await adapter.handle(commandMessage(), activeTurn), { decision });
    assert.deepEqual(responses, [{ id: "request_1", result: { decision } }]);
    assert.deepEqual(sanitizeCalls, ["SECRET command", "C:\\SECRET\\work", "SECRET reason"]);
    assert.deepEqual(prompts, [{
      type: "command",
      jobId: "job_1",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      command: "<redacted>",
      cwd: "<redacted>",
      reason: "<redacted>",
      decisions: ["accept", "decline", "cancel"],
    }]);
  }
});

test("normalizes file approvals without exposing command fields or persistent grants", async () => {
  const { adapter, responses, prompts, sanitizeCalls } = adapterFixture({ decision: "decline" });
  assert.deepEqual(await adapter.handle(fileMessage(), activeTurn), { decision: "decline" });
  assert.deepEqual(responses, [{ id: 7, result: { decision: "decline" } }]);
  assert.deepEqual(sanitizeCalls, ["SECRET file reason"]);
  assert.deepEqual(prompts, [{
    type: "file_change",
    jobId: "job_1",
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "item_2",
    reason: "<redacted>",
    decisions: ["accept", "decline", "cancel"],
  }]);
  assert.equal(JSON.stringify(prompts).includes("grantRoot"), false);
});

test("cancels invalid decision values and never forwards them", async () => {
  for (const decision of ["acceptForSession", "", "approve", {}, null]) {
    const { adapter, responses } = adapterFixture({ decision });
    await assert.rejects(
      adapter.handle(commandMessage(), activeTurn),
      (error) => assertSanitizedApprovalError(error, "invalid_decision", "decision"),
    );
    assert.deepEqual(responses, [{ id: "request_1", result: { decision: "cancel" } }]);
    assert.equal(JSON.stringify(responses).includes("acceptForSession"), false);
  }
});

test("rejects invalid contract and identity without retaining raw values", async () => {
  const cases = [
    [commandMessage({ id: {} }), activeTurn],
    [commandMessage({ id: "x".repeat(513) }), activeTurn],
    [commandMessage({ params: { itemId: "" } }), activeTurn],
    [commandMessage({ params: { threadId: "other" } }), activeTurn],
    [commandMessage({ params: { turnId: "other" } }), activeTurn],
    [commandMessage({ params: { cwd: "relative\\SECRET" } }), activeTurn],
    [commandMessage({ params: { command: "x".repeat(64 * 1024 + 1) } }), activeTurn],
    [commandMessage({ params: { reason: "x".repeat(16 * 1024 + 1) } }), activeTurn],
    [commandMessage({ params: { kind: "network" } }), activeTurn],
    [fileMessage({ params: { grantRoot: "C:\\SECRET" } }), activeTurn],
    [{ method: "unsupported/SECRET", id: 8, params: {} }, activeTurn],
    [commandMessage({ params: null }), activeTurn],
    [commandMessage(), { ...activeTurn, jobId: "" }],
  ];

  for (const [message, context] of cases) {
    const { adapter, responses } = adapterFixture();
    await assert.rejects(adapter.handle(message, context), (error) => {
      assert.ok(error instanceof AppServerCompatibilityError);
      assert.equal(error.code, "app_server_incompatible");
      assert.equal(error.details.stage, "approval");
      assert.equal(JSON.stringify(error).includes("SECRET"), false);
      return true;
    });
    assert.deepEqual(responses, []);
  }
});

test("sanitizes every nullable display field independently before prompting", async () => {
  const values = [];
  const { adapter, prompts } = adapterFixture({
    sanitizeForDisplay: (value) => {
      values.push(value);
      return value === null ? null : `safe_${values.length}`;
    },
  });
  await adapter.handle(commandMessage({ params: { command: null, cwd: null, reason: null } }), activeTurn);
  assert.deepEqual(values, [null, null, null]);
  assert.equal(prompts[0].command, null);
  assert.equal(prompts[0].cwd, null);
  assert.equal(prompts[0].reason, null);
});

test("sanitizer, decision-provider, and timeout failures attempt one cancel then fail sanitized", async () => {
  const failures = [
    {
      expected: ["sanitization_failed", "sanitize"],
      fixture: { sanitizeForDisplay: () => { throw new Error("SECRET sanitizer"); } },
    },
    {
      expected: ["decision_failed", "decision"],
      fixture: { requestDecision: async () => { throw new TypeError("SECRET provider"); } },
    },
    {
      expected: ["approval_timeout", "decision"],
      fixture: { requestDecision: () => new Promise(() => {}), timeoutMs: 1 },
    },
  ];

  for (const { fixture: overrides, expected } of failures) {
    const { adapter, responses } = adapterFixture(overrides);
    await assert.rejects(
      adapter.handle(commandMessage(), activeTurn),
      (error) => assertSanitizedApprovalError(error, expected[0], expected[1]),
    );
    assert.deepEqual(responses, [{ id: "request_1", result: { decision: "cancel" } }]);
  }
});

test("reports a sanitized cancel response failure instead of the original failure", async () => {
  const { adapter } = adapterFixture({
    requestDecision: async () => { throw new Error("SECRET provider"); },
    respond: async () => { throw new RangeError("SECRET transport"); },
  });
  await assert.rejects(
    adapter.handle(commandMessage(), activeTurn),
    (error) => assertSanitizedApprovalError(error, "cancel_response_failed", "respond")
      && error.details.causeType === "RangeError",
  );
});

test("rejects duplicate or concurrent approvals instead of queueing", async () => {
  let resolveFirst;
  const responses = [];
  const { adapter } = adapterFixture({
    respond: async (id, result) => responses.push({ id, result }),
    requestDecision: () => new Promise((resolve) => { resolveFirst = resolve; }),
  });
  const first = adapter.handle(commandMessage(), activeTurn);
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    adapter.handle(commandMessage(), activeTurn),
    (error) => assertSanitizedApprovalError(error, "duplicate_approval", "concurrency"),
  );
  assert.deepEqual(responses, []);

  await assert.rejects(
    adapter.handle(fileMessage(), activeTurn),
    (error) => assertSanitizedApprovalError(error, "approval_in_progress", "concurrency"),
  );
  assert.deepEqual(responses, [{ id: 7, result: { decision: "cancel" } }]);

  resolveFirst("accept");
  assert.deepEqual(await first, { decision: "accept" });
  assert.deepEqual(responses, [
    { id: 7, result: { decision: "cancel" } },
    { id: "request_1", result: { decision: "accept" } },
  ]);
});

test("unrefs and clears approval timers on success and decision failure", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  const cleared = [];
  globalThis.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, unrefCalled: false, unref() { this.unrefCalled = true; } };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => cleared.push(timer);
  try {
    await adapterFixture({ decision: "accept" }).adapter.handle(commandMessage(), activeTurn);
    await assert.rejects(adapterFixture({ decision: "invalid" }).adapter.handle(commandMessage(), activeTurn));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(timers.length, 2);
  assert.ok(timers.every((timer) => timer.milliseconds === 100 && timer.unrefCalled));
  assert.deepEqual(cleared, timers);
});

test("validates adapter configuration bounds", () => {
  const valid = {
    respond() {},
    requestDecision() {},
    sanitizeForDisplay(value) { return value; },
  };
  for (const overrides of [
    { respond: null },
    { requestDecision: null },
    { sanitizeForDisplay: null },
    { timeoutMs: 0 },
    { timeoutMs: 300_001 },
    { timeoutMs: 1.5 },
  ]) {
    assert.throws(
      () => createAppServerApprovalAdapter({ ...valid, timeoutMs: 100, ...overrides }),
      AppServerApprovalError,
    );
  }
});
