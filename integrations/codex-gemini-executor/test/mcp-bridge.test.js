import test from "node:test";
import assert from "node:assert/strict";

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

test("reports the job id early and maps explicit elicitation decisions", async () => {
  const seen = [];
  const core = {
    async runGeminiTask(_request, hooks) {
      await hooks.onStarted("job_1");
      const decision = await hooks.requestDecision({ type: "command", command: "safe", decisions: ["accept", "decline", "cancel"] });
      return { jobId: "job_1", status: decision === "accept" ? "completed" : "cancelled", finalAnswer: "done", filesChanged: [], tests: [] };
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
