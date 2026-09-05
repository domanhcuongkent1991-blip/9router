import test from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  inputResponse,
} from "@modelcontextprotocol/server";
import { createGeminiMcpServer } from "../src/mcp-bridge.js";

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
  assert.equal(run.config.inputSchema.safeParse({ task: "x", workspace: "D:\\Repo", model: "bad" }).success, false);
  assert.equal(run.config.inputSchema.safeParse({ task: "x", workspace: "D:\\Repo" }).success, true);
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

function approvalCore(count = 1) {
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
