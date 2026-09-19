import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  inputResponse,
} from "@modelcontextprotocol/server";
import { createGeminiMcpServer } from "../src/mcp-bridge.js";
import { createGeminiCompanionCore } from "../src/core.js";
import { createAppServerJsonlClient } from "../src/app-server/jsonl-client.js";
import { createAppServerSessionAdapter } from "../src/app-server/session.js";
import { createCompanionRedactor } from "../src/redaction.js";
import { createJobStateStore } from "../src/state-store.js";
import { createWorkspaceLeaseManager } from "../src/workspace-lease.js";

class FakeServer {
  constructor(info, options) { this.info = info; this.options = options; this.tools = new Map(); }
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
}

test("registers exactly three bounded tools and rejects routing overrides", async () => {
  const core = {
    async runGeminiTask(request, hooks) { await hooks.onStarted("job_1"); return { jobId: "job_1", status: "completed", finalAnswer: "done", filesChanged: [], tests: [] }; },
    getGeminiStatus(jobId) { return { jobId, status: "running" }; },
    async cancelGeminiTask(jobId) { return { jobId, status: "cancelled" }; },
  };
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  assert.deepEqual([...server.tools.keys()], ["run_gemini_task", "get_gemini_status", "cancel_gemini_task"]);
  const run = server.tools.get("run_gemini_task");
  assert.equal(run.config.inputSchema.safeParse({ task: "x", workspace: "D:\\Repo", model: "gemini-fast" }).success, false);
  assert.equal(run.config.inputSchema.safeParse({ task: "x", workspace: "D:\\Repo", model: "bad\nmodel" }).success, false);
  assert.equal(run.config.inputSchema.safeParse({ task: "x", workspace: "D:\\Repo", provider_url: "https://example.invalid" }).success, false);
  assert.equal(run.config.inputSchema.safeParse({ task: "x", workspace: "D:\\Repo" }).success, true);
});

test("exposes scope and write intent approval but rejects caller model overrides", () => {
  const core = {
    async runGeminiTask() {}, getGeminiStatus() {}, async cancelGeminiTask() {},
    modelPolicy: Object.freeze({ defaultModel: "gemini-fixed" }),
  };
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const schema = server.tools.get("run_gemini_task").config.inputSchema;
  const scoped = {
    task: "edit source", workspace: "D:\\Repo", access: "workspace-write",
    scope: { read: ["src"], write: ["src"], allow_create: true },
  };
  assert.equal(schema.safeParse(scoped).success, true);
  assert.equal(schema.safeParse({ ...scoped, model: "caller-model" }).success, false);
  assert.equal(schema.safeParse({ ...scoped, access: "scoped-edit" }).success, false);
  assert.equal(schema.safeParse({ ...scoped, scope: { read: ["src"], write: "src" } }).success, false);
});

test("reports the job id early for a terminal run", async () => {
  const seen = [];
  const core = {
    async runGeminiTask(_request, hooks) {
      await hooks.onStarted("job_1");
      return { jobId: "job_1", status: "completed", finalAnswer: "done", filesChanged: [], tests: [] };
    },
    getGeminiStatus() {}, async cancelGeminiTask() {},
  };
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const result = await server.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" },
    { mcpReq: {
      notify: async (message) => seen.push(message),
      elicitInput: async () => ({ action: "accept", content: { decision: "accept" } }),
    } },
  );
  assert.deepEqual(seen[0].params.data, { jobId: "job_1" });
  assert.equal(result.structuredContent.status, "completed");
});

test("filters non-contract classified error details in MCP terminal results", async () => {
  const core = {
    async runGeminiTask(_request, hooks) {
      await hooks.onStarted("job_error");
      return {
        jobId: "job_error", status: "failed",
        error: {
          category: "quota_exceeded", source: "unknown", code: "usageLimitExceeded", status: 429,
          stage: "event", reason: "turn_failed", field: "codexErrorInfo",
        },
      };
    },
    getGeminiStatus() {}, async cancelGeminiTask() {},
  };
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const result = await server.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" }, { mcpReq: { requestState: () => undefined } },
  );
  assert.deepEqual(result.structuredContent.error, {
    category: "quota_exceeded", source: "unknown", code: "usageLimitExceeded", status: 429,
    stage: "event",
  });
});

test("does not echo caller-controlled metadata through a direct MCP rejection", async () => {
  const sentinel = "sentinel-untrusted-4829";
  const core = {
    async runGeminiTask(_request, hooks) {
      await hooks.onStarted("job_direct_rejection");
      throw Object.assign(new Error("secret"), {
        code: "invalid_request", details: { field: "model", reason: sentinel, stage: sentinel },
      });
    },
    getGeminiStatus() {}, async cancelGeminiTask() {},
  };
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const result = await server.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" }, { mcpReq: { requestState: () => undefined } },
  );
  assert.deepEqual(result.structuredContent.error, {
    category: "invalid_request", source: "unknown", code: "invalid_request", field: "model",
  });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("keeps a real local session diagnostic aligned across core, persisted restart, and MCP", async () => {
  const files = new Map();
  const store = createJobStateStore({
    stateRoot: "C:\\runtime\\jobs", mkdirPath: async () => {},
    writeFile: async (path, data) => files.set(path, data),
    renamePath: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (path) => {
      if (!files.has(path)) { const error = new Error("missing"); error.code = "ENOENT"; throw error; }
      return files.get(path);
    },
    listDirectory: async () => ["job_local_session.json"], now: () => "now",
  });
  const session = createAppServerSessionAdapter({
    model: "gemini-fixed",
    client: { request: async () => ({ thread: { id: "" } }) },
  });
  const core = createGeminiCompanionCore({
    validateRequest: async (request) => ({
      task: request.task, workspace: request.workspace, effort: "medium", access: "read-only", timeoutMinutes: 30,
    }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(),
    createRuntime: async () => ({
      run: async () => session.startThread({ cwd: "D:\\Repo", sandbox: "read-only", approvalPolicy: "on-request" }),
      cancel: async () => {}, dispose: async () => {},
    }),
    persistStatus: store.persist, generateJobId: () => "job_local_session",
  });
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const result = await server.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" }, { mcpReq: { requestState: () => undefined } },
  );
  const expected = {
    category: "protocol_error", source: "unknown", stage: "response", reason: "invalid_thread_response",
  };
  assert.deepEqual(core.getGeminiStatus("job_local_session").error, expected);
  assert.deepEqual(result.structuredContent.error, expected);
  const recovered = await store.reconcile();
  assert.deepEqual(recovered[0].error, expected);
  const restarted = createGeminiCompanionCore({
    validateRequest: async () => ({}), prepareRuntime: async () => ({ run: async () => ({}) }),
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(), initialStatuses: recovered,
  });
  assert.deepEqual(restarted.getGeminiStatus("job_local_session").error, expected);
});

test("contains inherited-property JSONL codes through core cleanup and MCP", async () => {
  const codes = ["toString", "constructor", "valueOf", "__proto__"];
  let cancelled = 0;
  let disposed = 0;
  let next = 0;
  const core = createGeminiCompanionCore({
    validateRequest: async (request) => ({
      task: request.task, workspace: request.workspace, effort: "medium", access: "read-only", timeoutMinutes: 30,
    }),
    compatibilityAdapter: { check: async () => ({ status: "compatible", warnings: [] }) },
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(),
    generateJobId: () => `job_jsonl_${++next}`,
    createRuntime: async () => ({
      async run() {
        const readable = new PassThrough();
        const writable = new PassThrough();
        const client = createAppServerJsonlClient({ readable, writable });
        const pending = client.request("turn/start", {});
        readable.write(`${JSON.stringify({ id: 1, error: {
          code: codes[next - 1], source: "provider", message: "secret body",
        } })}\n`);
        try {
          await pending;
          throw new Error("missing JSONL rejection");
        } finally {
          client.close();
        }
      },
      cancel: async () => { cancelled += 1; },
      dispose: async () => { disposed += 1; },
    }),
  });
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  for (const code of codes) {
    const result = await server.tools.get("run_gemini_task").handler(
      { task: "x", workspace: "D:\\Repo" }, { mcpReq: { requestState: () => undefined } },
    );
    assert.deepEqual(result.structuredContent.error, { category: "protocol_error", source: "provider" });
    assert.equal(typeof result.structuredContent.error.category, "string");
    assert.equal(JSON.stringify(result).includes(code), false);
  }
  assert.equal(cancelled, codes.length);
  assert.equal(disposed, codes.length);
});

test("fails closed without starting a job when verified request state access throws", async () => {
  let starts = 0;
  const core = {
    async runGeminiTask() { starts += 1; return { jobId: "unexpected", status: "completed" }; },
    getGeminiStatus() {}, async cancelGeminiTask() {},
  };
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const run = server.tools.get("run_gemini_task").handler;
  await assert.rejects(
    run({ task: "x", workspace: "D:\\Repo" }, { mcpReq: { requestState: () => { throw new Error("raw verifier secret"); } } }),
    (error) => error.message === "invalid_approval_correlation" && !error.message.includes("raw verifier secret"),
  );
  assert.equal(starts, 0);
});

test("fails closed on orphan input responses without verified request state", async () => {
  for (const orphan of [
    { inputResponses: { approval: { action: "cancel" } } },
    { droppedInputResponseKeys: ["approval"] },
  ]) {
    let starts = 0;
    const core = {
      async runGeminiTask() { starts += 1; return { jobId: "unexpected", status: "completed" }; },
      getGeminiStatus() {}, async cancelGeminiTask() {},
    };
    const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
    const run = server.tools.get("run_gemini_task").handler;
    await assert.rejects(
      run({ task: "x", workspace: "D:\\Repo" }, { mcpReq: { requestState: () => undefined, ...orphan } }),
      (error) => error.message === "invalid_approval_correlation",
    );
    assert.equal(starts, 0);
  }
});

function approvalCore(count = 1, approvalOverrides = {}) {
  const decisions = [];
  return {
    decisions,
    core: {
      async runGeminiTask(_request, hooks) {
        await hooks.onStarted("job_approval");
        try {
          for (let index = 0; index < count; index += 1) {
            decisions.push(await hooks.requestDecision({
              type: "command", jobId: "job_approval", threadId: "thr_1", turnId: "turn_1",
              itemId: `item_${index}`, command: `command_${index}`, cwd: "D:\\Repo", reason: "test",
              decisions: ["accept", "decline", "cancel"],
              ...approvalOverrides,
            }));
          }
          return { jobId: "job_approval", status: "completed", finalAnswer: "done", filesChanged: [], tests: [] };
        } catch {
          return { jobId: "job_approval", status: "failed", error: { category: "protocol_error" } };
        }
      },
      getGeminiStatus() { return { jobId: "job_approval", status: "running" }; },
      async cancelGeminiTask() { return { jobId: "job_approval", status: "cancelled" }; },
    },
  };
}

function modernContext({ requestState, inputResponses } = {}) {
  let pushElicitationCalls = 0;
  return {
    context: { mcpReq: {
      envelope: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
      requestState: () => requestState,
      inputResponses,
      notify: async () => {},
      elicitInput: async () => { pushElicitationCalls += 1; throw new Error("must not be called in modern era"); },
    } },
    pushCalls: () => pushElicitationCalls,
  };
}

test("rejects caller model overrides before starting a continuation", async () => {
  const approval = approvalCore();
  approval.core.modelPolicy = Object.freeze({ defaultModel: "gemini-a", allowedModels: Object.freeze(["gemini-a", "gemini-b"]) });
  const server = createGeminiMcpServer({ core: approval.core, ServerClass: FakeServer, generateCorrelationId: () => "capability_model" });
  const run = server.tools.get("run_gemini_task").handler;
  const first = await run({ task: "x", workspace: "D:\\Repo" }, modernContext().context);
  const rejected = await run({ task: "x", workspace: "D:\\Repo", model: "gemini-b" }, modernContext({
    requestState: first.requestState,
    inputResponses: { approval: { action: "accept", content: { decision: "accept" } } },
  }).context);
  assert.equal(rejected.structuredContent.status, "failed");
  assert.deepEqual(approval.decisions, ["cancel"]);
});

class NoElicitationServer extends FakeServer {
  constructor(...args) {
    super(...args);
    this.server = { getClientCapabilities: () => ({}) };
  }
}

class DisconnectableServer extends FakeServer {
  constructor(...args) {
    super(...args);
    this.server = {};
  }
}

test("fails closed when a legacy client cannot elicit", async () => {
  const approval = approvalCore();
  const server = createGeminiMcpServer({ core: approval.core, ServerClass: NoElicitationServer, generateCorrelationId: () => "capability_none" });
  const result = await server.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" },
    { mcpReq: { requestState: () => undefined, notify: async () => {} } },
  );
  assert.equal(result.structuredContent.status, "failed");
  assert.deepEqual(approval.decisions, ["cancel"]);
});

test("cleans one-use approval correlations after cancellation and disconnect", async () => {
  for (const disconnect of [false, true]) {
    const approval = approvalCore();
    const ServerClass = disconnect ? DisconnectableServer : FakeServer;
    const server = createGeminiMcpServer({ core: approval.core, ServerClass, generateCorrelationId: () => `capability_${disconnect ? "disconnect" : "cancel"}` });
    const run = server.tools.get("run_gemini_task").handler;
    const awaiting = await run({ task: "x", workspace: "D:\\Repo" }, modernContext().context);
    if (disconnect) {
      server.server.onclose();
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      await server.tools.get("cancel_gemini_task").handler({ job_id: "job_approval" });
    }
    assert.deepEqual(approval.decisions, ["cancel"]);
    await assert.rejects(run({ task: "x", workspace: "D:\\Repo" }, modernContext({
      requestState: awaiting.requestState,
      inputResponses: { approval: { action: "accept", content: { decision: "accept" } } },
    }).context), /invalid_approval_correlation/u);
  }
});

test("disconnect cancels an active run before its first approval is published", async () => {
  let releaseRun;
  let cancellations = 0;
  const runReleased = new Promise((resolve) => { releaseRun = resolve; });
  const core = {
    async runGeminiTask(_request, hooks) {
      await hooks.onStarted("job_preapproval");
      await runReleased;
      return { jobId: "job_preapproval", status: "cancelled" };
    },
    getGeminiStatus() { return { jobId: "job_preapproval", status: "running" }; },
    async cancelGeminiTask() { cancellations += 1; releaseRun(); return { jobId: "job_preapproval", status: "cancelled" }; },
  };
  const server = createGeminiMcpServer({ core, ServerClass: DisconnectableServer });
  const running = server.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" }, modernContext().context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  server.server.onclose();
  const result = await running;
  assert.equal(cancellations, 1);
  assert.equal(result.structuredContent.status, "cancelled");
});

test("uses SDK 2.0 input_required for modern approval without push elicitation", async () => {
  const approval = approvalCore();
  const server = createGeminiMcpServer({ core: approval.core, ServerClass: FakeServer, generateCorrelationId: () => "capability_1" });
  const run = server.tools.get("run_gemini_task").handler;
  const firstContext = modernContext();
  const first = await run({ task: "x", workspace: "D:\\Repo" }, firstContext.context);
  assert.equal(first.resultType, "input_required");
  assert.equal(first.requestState, "capability_1");
  assert.equal(first.inputRequests.approval.method, "elicitation/create");
  assert.equal(firstContext.pushCalls(), 0);

  const responses = { approval: { action: "accept", content: { decision: "accept" } } };
  assert.deepEqual(inputResponse(responses, "approval"), { kind: "elicit", action: "accept", content: { decision: "accept" } });
  const retryContext = modernContext({ requestState: "capability_1", inputResponses: responses });
  const result = await run({ task: "x", workspace: "D:\\Repo" }, retryContext.context);
  assert.equal(result.structuredContent.status, "completed");
  assert.deepEqual(approval.decisions, ["accept"]);
  assert.equal(retryContext.pushCalls(), 0);
});

test("elicitation schema carries sanitized structured command actions without making them required", async () => {
  const actions = [{ type: "read", command: "Get-Content -Raw marker.txt", name: "marker.txt", path: "D:\\Repo\\marker.txt" }];
  const server = createGeminiMcpServer({
    core: approvalCore(1, { commandActions: actions, command: "SECRET wrapped command" }).core,
    ServerClass: FakeServer,
    generateCorrelationId: () => "capability_schema",
  });
  const first = await server.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" }, modernContext().context,
  );
  const { message, requestedSchema } = first.inputRequests.approval.params;
  assert.match(message, /^Command: SECRET wrapped command\nDirectory: D:\\Repo\nReason: test$/u);
  assert.equal(requestedSchema.type, "object");
  assert.deepEqual(requestedSchema.required, ["decision"]);
  assert.deepEqual(JSON.parse(requestedSchema.properties.commandActions.const), actions);
  assert.equal(requestedSchema.properties.decision.enum.join(","), "accept,decline,cancel");

  const bare = createGeminiMcpServer({
    core: approvalCore(1).core,
    ServerClass: FakeServer,
    generateCorrelationId: () => "capability_schema_bare",
  });
  const bareResult = await bare.tools.get("run_gemini_task").handler(
    { task: "x", workspace: "D:\\Repo" }, modernContext().context,
  );
  const bareSchema = bareResult.inputRequests.approval.params.requestedSchema;
  assert.equal(bareSchema.properties.commandActions.const, "null");
});

test("correlates sequential approvals and fails closed on forged request reuse", async () => {
  const approval = approvalCore(2);
  let next = 0;
  const server = createGeminiMcpServer({ core: approval.core, ServerClass: FakeServer, generateCorrelationId: () => `capability_${++next}` });
  const run = server.tools.get("run_gemini_task").handler;
  const first = await run({ task: "x", workspace: "D:\\Repo" }, modernContext().context);
  const second = await run({ task: "x", workspace: "D:\\Repo" }, modernContext({
    requestState: first.requestState,
    inputResponses: { approval: { action: "accept", content: { decision: "accept" } } },
  }).context);
  assert.equal(second.resultType, "input_required");
  assert.notEqual(second.requestState, first.requestState);
  const terminal = await run({ task: "x", workspace: "D:\\Repo" }, modernContext({
    requestState: second.requestState,
    inputResponses: { approval: { action: "decline" } },
  }).context);
  assert.equal(terminal.structuredContent.status, "completed");
  assert.deepEqual(approval.decisions, ["accept", "decline"]);

  const forgedApproval = approvalCore();
  const forgedServer = createGeminiMcpServer({ core: forgedApproval.core, ServerClass: FakeServer, generateCorrelationId: () => "capability_forged" });
  const forgedRun = forgedServer.tools.get("run_gemini_task").handler;
  const awaiting = await forgedRun({ task: "original", workspace: "D:\\Repo" }, modernContext().context);
  const rejected = await forgedRun({ task: "changed", workspace: "D:\\Repo" }, modernContext({
    requestState: awaiting.requestState,
    inputResponses: { approval: { action: "accept", content: { decision: "accept" } } },
  }).context);
  assert.equal(rejected.structuredContent.status, "failed");
  assert.deepEqual(forgedApproval.decisions, ["cancel"]);
});

test("binds write-intent continuation to canonical scope and never exposes write text", async () => {
  const approvals = [];
  const decisions = [];
  const core = {
    modelPolicy: Object.freeze({ defaultModel: "gemini-fixed" }),
    async runGeminiTask(_request, hooks) {
      await hooks.onStarted("job_write_intent");
      decisions.push(await hooks.requestDecision({
        type: "write_intent", operation: "replace_text", path: "src\\auth.js",
        expectedSha256: "a".repeat(64), operationFingerprint: "b".repeat(64),
        old_text: "TOP SECRET OLD", new_text: "TOP SECRET NEW", text: "TOP SECRET TEXT", deadline: 123,
      }));
      return { jobId: "job_write_intent", status: "completed", finalAnswer: "done", filesChanged: [], tests: [] };
    },
    getGeminiStatus() {}, async cancelGeminiTask() { return { jobId: "job_write_intent", status: "cancelled" }; },
  };
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer, generateCorrelationId: () => "scope_write_intent" });
  const run = server.tools.get("run_gemini_task").handler;
  const request = {
    task: "edit", workspace: "D:\\Repo", access: "workspace-write",
    scope: { read: ["src"], write: ["src"], allow_create: false },
  };
  const first = await run(request, modernContext().context);
  const schemaFacts = JSON.parse(first.inputRequests.approval.params.requestedSchema.properties.commandActions.const);
  approvals.push(first.inputRequests.approval.params.message, first.structuredContent);
  assert.deepEqual(schemaFacts, {
    type: "write_intent", operation: "replace_text", path: "src\\auth.js",
    expectedSha256: "a".repeat(64), operationFingerprint: "b".repeat(64), deadline: 123, model: "gemini-fixed",
  });
  assert.equal(JSON.stringify(approvals).includes("TOP SECRET"), false);

  const rejected = await run({ ...request, scope: { ...request.scope, allow_create: true } }, modernContext({
    requestState: first.requestState,
    inputResponses: { approval: { action: "accept", content: { decision: "accept" } } },
  }).context);
  assert.equal(rejected.structuredContent.status, "failed");
  assert.deepEqual(decisions, ["cancel"]);
});

test("SDK 2.0 legacy shim performs elicitation and re-enters the same handler", async () => {
  const approval = approvalCore();
  const server = createGeminiMcpServer({ core: approval.core, generateCorrelationId: () => "legacy_capability" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let requestId = 0;
  const responses = new Map();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++requestId;
    responses.set(id, { resolve, reject });
    clientTransport.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
  });
  clientTransport.onmessage = (message) => {
    if (message.method === "elicitation/create") {
      void clientTransport.send({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { decision: "accept" } } });
      return;
    }
    const pending = responses.get(message.id);
    if (!pending) return;
    responses.delete(message.id);
    if (message.error) pending.reject(new Error("MCP request failed"));
    else pending.resolve(message.result);
  };
  await clientTransport.start();
  await server.connect(serverTransport);
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: {} },
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const result = await request("tools/call", { name: "run_gemini_task", arguments: { task: "x", workspace: "D:\\Repo" } });
  assert.equal(result.structuredContent.status, "completed");
  assert.deepEqual(approval.decisions, ["accept"]);
  await server.close();
});

test("SDK 2.0 modern seam emits input_required and accepts a correlated retry", async () => {
  const approval = approvalCore();
  const server = createGeminiMcpServer({ core: approval.core, generateCorrelationId: () => "modern_capability" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  let nextId = 0;
  clientTransport.onmessage = (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error("MCP request failed"));
    else entry.resolve(message.result);
  };
  const request = (params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    clientTransport.send({ jsonrpc: "2.0", id, method: "tools/call", params }).catch(reject);
  });
  await clientTransport.start();
  await server.connect(serverTransport);
  server.server._negotiatedProtocolVersion = "2026-07-28";
  const envelope = {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_INFO_META_KEY]: { name: "test-client", version: "1.0.0" },
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
  };
  const args = { task: "x", workspace: "D:\\Repo" };
  const first = await request({ name: "run_gemini_task", arguments: args, _meta: envelope });
  assert.equal(first.resultType, "input_required");
  assert.equal(first.requestState, "modern_capability");
  const result = await request({
    name: "run_gemini_task", arguments: args, requestState: first.requestState,
    inputResponses: { approval: { action: "accept", content: { decision: "accept" } } },
    _meta: envelope,
  });
  assert.equal(result.resultType, "complete");
  assert.equal(result.structuredContent.status, "completed");
  assert.deepEqual(approval.decisions, ["accept"]);
  await server.close();
});
