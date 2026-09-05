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

function protocolHarness(child, { onTurnStart } = {}) {
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
      if (frame.method === "turn/start" && onTurnStart) {
        onTurnStart(frame, results[frame.method]);
        continue;
      }
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
    observeExecutable: async () => ({ executablePath: "C:\\CodexDesktop\\codex.exe", version: "2.0.0", executableSha256: "a".repeat(64) }),
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

test("fails closed when an early turn event disagrees with the turn/start response", async () => {
  const child = fakeChild();
  protocolHarness(child, {
    onTurnStart: (frame, result) => {
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: {
        threadId: "thr_1", turn: { id: "turn_A", status: "inProgress", items: [] },
      } })}\n`);
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ id: frame.id, result: { ...result, turn: { ...result.turn, id: "turn_B" } } })}\n`);
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
          threadId: "thr_1", turn: { id: "turn_B", status: "completed", items: [] },
        } })}\n`));
      });
    },
  });
  const runtime = await prepareAppServerRuntime(options(child));
  await assert.rejects(runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only" },
    executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
  }), (error) => error.code === "app_server_incompatible" && error.details.reason === "turn_start_mismatch");
  await runtime.dispose().catch(() => {});
});

test("sanitizes split-secret deltas before retaining the final answer", async () => {
  const child = fakeChild(); protocolHarness(child);
  const secret = "split-secret-value";
  const runtime = await prepareAppServerRuntime(options(child, {
    sanitizeForDisplay: (value) => value.replaceAll(secret, "[REDACTED]"),
  }));
  const running = runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only" }, executionWorkspace: "D:\\Repo",
    onEvent: async () => {}, requestDecision: async () => "accept",
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (const delta of ["split-secret-", "value"]) {
    child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: {
      threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta,
    } })}\n`);
  }
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
    threadId: "thr_1", turn: { id: "turn_1", status: "completed", items: [] },
  } })}\n`);
  const result = await running;
  assert.equal(result.finalAnswer, "[REDACTED]");
  assert.equal(JSON.stringify(result).includes(secret), false);
  await runtime.dispose();
});

test("generates schema and launches from the exact canonical observed executable", async () => {
  const child = fakeChild(); protocolHarness(child);
  const launches = [];
  const schemaObservations = [];
  const canonical = "C:\\CodexDesktop\\real\\codex.exe";
  const runtime = await prepareAppServerRuntime(options(child, {
    executablePath: "C:\\CodexDesktop\\alias\\codex.exe",
    observeExecutable: async () => ({ executablePath: canonical, version: "2.0.0", executableSha256: "a".repeat(64) }),
    loadSchemaQualification: async (observation) => {
      schemaObservations.push(observation.executablePath);
      return options(child).schemaQualification;
    },
    schemaQualification: undefined,
    spawnProcess: (file) => { launches.push(file); return child; },
  }));
  assert.deepEqual(schemaObservations, [canonical]);
  assert.deepEqual(launches, [canonical]);
  await runtime.dispose();
});
