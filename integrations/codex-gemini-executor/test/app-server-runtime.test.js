import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import { prepareAppServerRuntime } from "../src/app-server/runtime.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  return child;
}

function protocolHarness(child) {
  const frames = [];
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const frame = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      frames.push(frame);
      if (!Object.hasOwn(frame, "id") || typeof frame.method !== "string") continue;
      const results = {
        initialize: { userAgent: "codex-test", platformFamily: "windows", platformOs: "windows", codexHome: "C:\\isolated" },
        "model/list": { data: [] },
        "thread/start": { thread: { id: "thr_1" } },
        "thread/resume": { thread: { id: "thr_1" } },
        "turn/start": { turn: { id: "turn_1", status: "inProgress" } },
        "turn/interrupt": {},
      };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: frame.id, result: results[frame.method] })}\n`));
    }
  });
  return frames;
}

function options(child, overrides = {}) {
  return {
    executablePath: "C:\\CodexDesktop\\codex.exe",
    codexHome: "C:\\isolated",
    workingDirectory: "D:\\Repo",
    environment: { PATH: "fixed" },
    spawnProcess: () => child,
    observeExecutable: async () => ({ version: "2.0.0", executableSha256: "a".repeat(64) }),
    baseline: { version: "1.0.0", executableSha256: "b".repeat(64) },
    clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
    schemaQualification: { schemaSubsetCompatible: true, methods: Object.fromEntries(APP_SERVER_REQUIRED_METHODS.map((name) => [name, true])) },
    fixedModel: "gemini-fixed", fixedModelProvider: "nine_router",
    sanitizeForDisplay: (value) => value,
    ...overrides,
  };
}

test("qualifies and runs the same fake App Server process through normalized events", async () => {
  const child = fakeChild();
  const frames = protocolHarness(child);
  const warnings = [];
  const runtime = await prepareAppServerRuntime(options(child, { onWarning: (warning) => warnings.push(warning.code) }));
  const events = [];
  const running = runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only" },
    executionWorkspace: "D:\\Repo", onEvent: async (event) => events.push(event),
    requestDecision: async () => "accept",
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1", status: "inProgress", items: [] } } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "hello" } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed", items: [] } } })}\n`);
  const result = await running;
  assert.deepEqual(result, { sessionId: "thr_1", finalAnswer: "hello", filesChanged: [], tests: [] });
  assert.deepEqual(frames.filter((frame) => Object.hasOwn(frame, "id")).map((frame) => frame.method), [
    "initialize", "model/list", "thread/start", "turn/start",
  ]);
  assert.deepEqual(events.map((event) => event.type), ["turn_started", "assistant_delta", "turn_completed"]);
  assert.deepEqual(warnings, ["codex_version_changed", "codex_executable_changed"]);
  await runtime.dispose();
});

test("relays approval once and fails closed when elicitation is unavailable", async () => {
  const child = fakeChild(); protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child));
  const events = [];
  const running = runtime.run({
    request: { task: "change", effort: "high", access: "workspace-write" },
    executionWorkspace: "C:\\jobs\\job_1", onEvent: async (event) => events.push(event),
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "item/commandExecution/requestApproval", id: 9, params: {
    threadId: "thr_1", turnId: "turn_1", itemId: "item_1", command: "npm test", cwd: "C:\\jobs\\job_1", reason: "test"
  } })}\n`);
  await assert.rejects(running, { code: "app_server_approval_error" });
  assert.equal(events.some((event) => event.type === "approval_required"), true);
  await runtime.dispose().catch(() => {});
});

test("malformed capabilities fail before the App Server child is launched", async () => {
  let spawned = 0;
  const child = fakeChild();
  await assert.rejects(prepareAppServerRuntime(options(child, {
    spawnProcess: () => { spawned += 1; return child; },
    schemaQualification: { schemaSubsetCompatible: false, methods: {} },
  })), (error) => error.code === "app_server_incompatible" && error.userMessage === "Codex version chưa được hỗ trợ");
  assert.equal(spawned, 0);
});
