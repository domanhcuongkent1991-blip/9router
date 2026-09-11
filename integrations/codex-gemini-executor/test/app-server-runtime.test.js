import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import { prepareAppServerRuntime } from "../src/app-server/runtime.js";
import { createGeminiCompanionCore } from "../src/core.js";
import { classifyCompanionError } from "../src/error-classification.js";
import { createGeminiMcpServer } from "../src/mcp-bridge.js";
import { createCompanionRedactor } from "../src/redaction.js";
import { createWorkspaceLeaseManager } from "../src/workspace-lease.js";

class FakeServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  child.stdin.on("finish", () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); });
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
    model: "gemini-fixed",
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
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
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
  assert.deepEqual(frames.filter((frame) => ["thread/start", "turn/start"].includes(frame.method)).map((frame) => frame.params.model), [
    "gemini-fixed", "gemini-fixed",
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
    request: { task: "change", effort: "high", access: "workspace-write", model: "gemini-fixed" },
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
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
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
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" }, executionWorkspace: "D:\\Repo",
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
    spawnProcess: (file, args) => {
      const payloadIndex = args.indexOf("-LaunchSpecBase64");
      launches.push(payloadIndex >= 0
        ? JSON.parse(Buffer.from(args[payloadIndex + 1], "base64").toString("utf8")).executablePath
        : file);
      return child;
    },
  }));
  assert.deepEqual(schemaObservations, [canonical]);
  assert.deepEqual(launches, [canonical]);
  await runtime.dispose();
});

test("rejects a request whose resolved model differs from its model-bound runtime", async () => {
  const child = fakeChild(); protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child, { model: "gemini-a" }));
  await assert.rejects(runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-b" },
    executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
  }), { code: "app_server_incompatible" });
  await runtime.dispose();
});

test("preserves the finite diagnostic from an actual unavailable runtime", async () => {
  const child = fakeChild(); protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child));
  await runtime.dispose();
  await assert.rejects(runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
    executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
  }), (error) => {
    assert.deepEqual(classifyCompanionError(error), {
      category: "app_server_incompatible", source: "unknown", code: "app_server_incompatible",
      stage: "runtime", reason: "runtime_unavailable",
    });
    return true;
  });
});

test("retains a terminal notification's safe error when failed completion metadata is empty", async () => {
  for (const completionError of [undefined, { message: "synthetic" }, { message: "synthetic", codexErrorInfo: null }]) {
    const child = fakeChild(); protocolHarness(child);
    const runtime = await prepareAppServerRuntime(options(child));
    const secret = "app-server-turn-secret";
    const events = [];
    const running = runtime.run({
      request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
      executionWorkspace: "D:\\Repo", onEvent: async (event) => events.push(event), requestDecision: async () => "accept",
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`${JSON.stringify({ method: "error", params: {
      threadId: "thr_1", turnId: "turn_1", willRetry: false,
      error: { message: secret, additionalDetails: secret, codexErrorInfo: "usageLimitExceeded" },
    } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
      threadId: "thr_1", turn: { id: "turn_1", status: "failed", items: [], ...(completionError === undefined ? {} : { error: completionError }) },
    } })}\n`);
    await assert.rejects(running, (error) => (
      error.code === "app_server_turn_error"
      && error.details.remoteCode === "usageLimitExceeded"
      && error.details.remoteSource === "unknown"
      && !JSON.stringify(error).includes(secret)
    ));
    assert.deepEqual(events.map((event) => event.type), ["turn_error", "turn_completed"]);
    await runtime.dispose();
  }
});

test("uses useful completion metadata without mixing a prior terminal error", async () => {
  const child = fakeChild(); protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child));
  const running = runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
    executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "error", params: {
    threadId: "thr_1", turnId: "turn_1", willRetry: false,
    error: { message: "hidden", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
  } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
    threadId: "thr_1", turn: {
      id: "turn_1", status: "failed", items: [],
      error: { message: "hidden", codexErrorInfo: "rateLimitExceeded" },
    },
  } })}\n`);
  await assert.rejects(running, (error) => error.code === "app_server_turn_error"
    && error.details.remoteCode === "rateLimitExceeded" && error.details.remoteStatus === undefined);
  await runtime.dispose();
});

test("does not fail early for a retryable error notification followed by success", async () => {
  const child = fakeChild(); protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child));
  const running = runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
    executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "error", params: {
    threadId: "thr_1", turnId: "turn_1", willRetry: true,
    error: { message: "retry", codexErrorInfo: "rateLimitExceeded" },
  } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
    threadId: "thr_1", turn: { id: "turn_1", status: "completed", items: [] },
  } })}\n`);
  assert.equal((await running).sessionId, "thr_1");
  await runtime.dispose();
});

test("keeps a failed turn uncertain when only a retryable error preceded empty completion metadata", async () => {
  const child = fakeChild(); protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child));
  const running = runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
    executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "error", params: {
    threadId: "thr_1", turnId: "turn_1", willRetry: true,
    error: { message: "retry", codexErrorInfo: "usageLimitExceeded" },
  } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
    threadId: "thr_1", turn: { id: "turn_1", status: "failed", items: [], error: { message: "synthetic" } },
  } })}\n`);
  await assert.rejects(running, (error) => error.code === "app_server_turn_error"
    && error.details.remoteCode === undefined && error.details.remoteStatus === undefined);
  await runtime.dispose();
});

test("uses a failed completion's embedded error when no error notification arrives", async () => {
  const child = fakeChild(); protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child));
  const running = runtime.run({
    request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
    executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
    threadId: "thr_1", turn: {
      id: "turn_1", status: "failed", items: [],
      error: { message: "hidden", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
    },
  } })}\n`);
  await assert.rejects(running, (error) => error.code === "app_server_turn_error"
    && error.details.remoteCode === "httpConnectionFailed" && error.details.remoteStatus === 503);
  await runtime.dispose();
});

test("fails closed and disposes after a foreign or malformed terminal error event", async () => {
  for (const notification of [
    { method: "error", params: { threadId: "foreign", turnId: "turn_1", willRetry: false, error: { message: "hidden" } } },
    { method: "error", params: { threadId: "thr_1", turnId: "turn_1", willRetry: false, error: { message: "hidden", codexErrorInfo: "invalid" } } },
  ]) {
    const child = fakeChild(); protocolHarness(child);
    const runtime = await prepareAppServerRuntime(options(child));
    const running = runtime.run({
      request: { task: "inspect", effort: "medium", access: "read-only", model: "gemini-fixed" },
      executionWorkspace: "D:\\Repo", onEvent: async () => {}, requestDecision: async () => "accept",
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`${JSON.stringify(notification)}\n`);
    await assert.rejects(running, { code: "app_server_incompatible" });
    await runtime.dispose();
    assert.equal(child.exitCode, 0);
  }
});

test("carries a failed App Server turn's safe error through core persistence, MCP, and cleanup", async () => {
  const child = fakeChild();
  const frames = protocolHarness(child);
  const runtime = await prepareAppServerRuntime(options(child));
  const persisted = [];
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({
      task: "inspect", workspace: "D:\\Repo", effort: "medium", access: "read-only", timeoutMinutes: 30, model: "gemini-fixed",
    }),
    prepareRuntime: async () => runtime,
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(),
    persistStatus: async (snapshot) => persisted.push(structuredClone(snapshot)), generateJobId: () => "job_turn_error",
  });
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const running = server.tools.get("run_gemini_task").handler(
    { task: "inspect", workspace: "D:\\Repo" }, { mcpReq: { requestState: () => undefined } },
  );
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ method: "error", params: {
    threadId: "thr_1", turnId: "turn_1", willRetry: false,
    error: { message: "secret", codexErrorInfo: "usageLimitExceeded" },
  } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
    threadId: "thr_1", turn: { id: "turn_1", status: "failed", items: [], error: { message: "synthetic", codexErrorInfo: null } },
  } })}\n`);
  const result = await running;
  const terminal = core.getGeminiStatus("job_turn_error");
  assert.deepEqual(terminal.error, {
    category: "quota_exceeded", source: "unknown", code: "usageLimitExceeded",
  });
  assert.deepEqual(result.structuredContent.error, terminal.error);
  assert.deepEqual(persisted.at(-1).error, terminal.error);
  assert.equal(frames.some((frame) => frame.method === "turn/interrupt"), true);
  assert.equal(child.exitCode, 0);
});
