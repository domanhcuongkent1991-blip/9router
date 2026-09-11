import test from "node:test";
import assert from "node:assert/strict";

import {
  AppServerSessionError,
  createAppServerSessionAdapter,
} from "../src/app-server/session.js";

const fixed = { model: "gemini-fixed" };
const threadPolicy = { cwd: "C:\\workspace", sandbox: "workspace-write", approvalPolicy: "on-request" };

function fixture(responses = {}) {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (responses[method] instanceof Error) throw responses[method];
      return responses[method];
    },
  };
  return { calls, session: createAppServerSessionAdapter({ client, ...fixed }) };
}

test("sends exact model-bound policy requests for all session commands", async () => {
  const { calls, session } = fixture({
    "thread/start": { thread: { id: "thr_1" } },
    "thread/resume": { thread: { id: "thr_1" } },
    "turn/start": { turn: { id: "turn_1", status: "inProgress" } },
    "turn/interrupt": {},
  });

  assert.deepEqual(await session.startThread(threadPolicy), { threadId: "thr_1" });
  assert.deepEqual(await session.resumeThread({ threadId: "thr_1", ...threadPolicy }), { threadId: "thr_1" });
  assert.deepEqual(await session.startTurn({ threadId: "thr_1", task: "  summarize this  ", effort: "high" }), {
    threadId: "thr_1", turnId: "turn_1", status: "running",
  });
  assert.deepEqual(await session.interruptTurn({ threadId: "thr_1", turnId: "turn_1" }), {
    threadId: "thr_1", turnId: "turn_1", status: "interrupt_requested",
  });

  assert.deepEqual(calls, [
    { method: "thread/start", params: { ...threadPolicy, model: "gemini-fixed", modelProvider: "nine_router", ephemeral: false } },
    { method: "thread/resume", params: { threadId: "thr_1", ...threadPolicy, model: "gemini-fixed", modelProvider: "nine_router" } },
    { method: "turn/start", params: { threadId: "thr_1", input: [{ type: "text", text: "summarize this" }], model: "gemini-fixed", effort: "high" } },
    { method: "turn/interrupt", params: { threadId: "thr_1", turnId: "turn_1" } },
  ]);
});

test("does not accept caller model or provider overrides", async () => {
  const { calls, session } = fixture({ "thread/start": { thread: { id: "thr_1" } } });
  await assert.rejects(
    session.startThread({ ...threadPolicy, model: "other-model" }),
    { code: "app_server_session_error", details: { reason: "invalid_input", stage: "input" } },
  );
  assert.deepEqual(calls, []);
});

test("rejects invalid inputs before transport", async () => {
  const { calls, session } = fixture();
  const invalidCalls = [
    () => session.startThread({ ...threadPolicy, cwd: "relative" }),
    () => session.startThread({ ...threadPolicy, sandbox: "danger-full-access" }),
    () => session.resumeThread({ threadId: "", ...threadPolicy }),
    () => session.resumeThread({ threadId: "thr_1", ...threadPolicy, approvalPolicy: "always" }),
    () => session.startTurn({ threadId: "thr_1", task: "   ", effort: "low" }),
    () => session.startTurn({ threadId: "thr_1", task: "x", effort: "maximum" }),
    () => session.interruptTurn({ threadId: "thr_1", turnId: "x".repeat(513) }),
  ];
  for (const invoke of invalidCalls) {
    await assert.rejects(invoke(), { code: "app_server_session_error", details: { reason: "invalid_input", stage: "input" } });
  }
  assert.deepEqual(calls, []);
});

test("validates bounded thread and turn responses", async () => {
  const start = fixture({ "thread/start": { thread: { id: "x".repeat(513) } } }).session;
  await assert.rejects(start.startThread(threadPolicy), { code: "app_server_session_error", details: { reason: "invalid_thread_response", stage: "response" } });

  const resume = fixture({ "thread/resume": { thread: { id: "other" } } }).session;
  await assert.rejects(resume.resumeThread({ threadId: "thr_1", ...threadPolicy }), { code: "app_server_session_error", details: { reason: "thread_id_mismatch", stage: "response" } });

  const turn = fixture({ "turn/start": { turn: { id: "turn_1", status: "completed" } } }).session;
  await assert.rejects(turn.startTurn({ threadId: "thr_1", task: "x", effort: "medium" }), { code: "app_server_session_error", details: { reason: "invalid_turn_response", stage: "response" } });

  const interrupt = fixture({ "turn/interrupt": [] }).session;
  await assert.rejects(interrupt.interruptTurn({ threadId: "thr_1", turnId: "turn_1" }), { code: "app_server_session_error", details: { reason: "invalid_interrupt_response", stage: "response" } });
});

test("sanitizes transport failures without retaining remote content", async () => {
  const { session } = fixture({ "thread/start": new Error("sensitive remote diagnostic") });
  await assert.rejects(session.startThread(threadPolicy), (error) => {
    assert.ok(error instanceof AppServerSessionError);
    assert.deepEqual(error.details, { reason: "request_failed", stage: "thread_start", causeType: "Error" });
    assert.equal(JSON.stringify(error).includes("sensitive remote diagnostic"), false);
    return true;
  });
});
