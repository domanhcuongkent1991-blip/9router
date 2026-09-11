import test from "node:test";
import assert from "node:assert/strict";

import { createGeminiCompanionCore } from "../src/core.js";
import { createGeminiMcpServer } from "../src/mcp-bridge.js";
import { createCompanionRedactor } from "../src/redaction.js";
import { createJobStateStore } from "../src/state-store.js";
import { createWorkspaceLeaseManager } from "../src/workspace-lease.js";

test("persists only minimal sanitized atomic state with revision guards", async () => {
  const files = new Map();
  const store = createJobStateStore({
    stateRoot: "C:\\runtime\\jobs",
    mkdirPath: async () => {},
    writeFile: async (path, data) => files.set(path, data),
    renamePath: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (path) => { if (!files.has(path)) { const e = new Error("missing"); e.code = "ENOENT"; throw e; } return files.get(path); },
    listDirectory: async () => [],
    now: () => "2026-09-05T00:00:00.000Z",
  });
  await store.persist({ jobId: "job_1", status: "running", workspace: "D:\\Repo", worktreePath: null,
    task: "SECRET task", output: "SECRET output", approval: { command: "SECRET" } });
  const saved = JSON.parse(files.get("C:\\runtime\\jobs\\job_1.json"));
  assert.deepEqual(saved, {
    jobId: "job_1", status: "running", revision: 1,
    workspace: "D:\\Repo", worktreePath: null, updatedAt: "2026-09-05T00:00:00.000Z",
  });
  await assert.rejects(store.persist({ jobId: "job_1", status: "completed" }, { expectedRevision: 0 }),
    { code: "stale_state_revision" });
});

test("does not rewrite another instance's nonterminal jobs during discovery", async () => {
  const files = new Map([["C:\\runtime\\jobs\\job_1.json", JSON.stringify({
    jobId: "job_1", status: "running", revision: 2, workspace: "D:\\Repo",
    worktreePath: "C:\\tmp\\CodexScratch\\9router-gemini-jobs\\job_1", updatedAt: "old",
  })]]);
  const store = createJobStateStore({
    stateRoot: "C:\\runtime\\jobs", mkdirPath: async () => {},
    writeFile: async (path, data) => files.set(path, data),
    renamePath: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (path) => files.get(path),
    listDirectory: async () => ["job_1.json"], now: () => "now",
  });
  const recovered = await store.reconcile();
  assert.equal(recovered[0].status, "running");
  assert.equal(recovered[0].revision, 2);
  assert.equal(JSON.parse(files.get("C:\\runtime\\jobs\\job_1.json")).status, "running");
  assert.equal(recovered[0].worktreePath.endsWith("job_1"), true);
});

test("serializes concurrent writes so revisions remain monotonic", async () => {
  const files = new Map();
  const store = createJobStateStore({
    stateRoot: "C:\\runtime\\jobs", mkdirPath: async () => {},
    writeFile: async (path, data) => files.set(path, data),
    renamePath: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (path) => { if (!files.has(path)) { const e = new Error("missing"); e.code = "ENOENT"; throw e; } return files.get(path); },
    listDirectory: async () => [], now: () => "now",
  });
  const [first, second] = await Promise.all([
    store.persist({ jobId: "job_1", status: "starting" }),
    store.persist({ jobId: "job_1", status: "running" }),
  ]);
  assert.deepEqual([first.revision, second.revision], [1, 2]);
  assert.equal(JSON.parse(files.get("C:\\runtime\\jobs\\job_1.json")).revision, 2);
});

test("returns valid terminal records so restart status queries remain available", async () => {
  const terminal = {
    jobId: "job_done", status: "completed", revision: 4, workspace: "D:\\Repo",
    worktreePath: null, sessionId: "thr_1", updatedAt: "old",
  };
  const store = createJobStateStore({
    stateRoot: "C:\\runtime\\jobs", mkdirPath: async () => {}, writeFile: async () => {}, renamePath: async () => {},
    readFile: async () => JSON.stringify(terminal), listDirectory: async () => ["job_done.json"], now: () => "now",
  });
  const recovered = await store.reconcile();
  assert.deepEqual(recovered, [terminal]);
  const restarted = createGeminiCompanionCore({
    validateRequest: async () => ({}), prepareRuntime: async () => ({ run: async () => ({}) }),
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(), initialStatuses: recovered,
  });
  assert.deepEqual(restarted.getGeminiStatus("job_done"), terminal);
});

test("preserves a legacy provider quota status through read, recovery, and MCP without rewriting it", async () => {
  const record = {
    jobId: "job_legacy_quota", status: "failed", revision: 1, updatedAt: "old",
    error: { category: "provider_quota_exceeded", cause: { message: "private legacy text" } },
  };
  const raw = JSON.stringify(record);
  let writes = 0;
  const store = createJobStateStore({
    stateRoot: "C:/runtime/jobs", mkdirPath: async () => {},
    writeFile: async () => { writes += 1; }, renamePath: async () => { writes += 1; },
    readFile: async () => raw, listDirectory: async () => ["job_legacy_quota.json"],
  });
  const expected = { category: "quota_exceeded", source: "provider" };
  assert.deepEqual((await store.read(record.jobId)).error, expected);
  const recovered = await store.reconcile();
  assert.deepEqual(recovered[0].error, expected);
  const core = createGeminiCompanionCore({
    validateRequest: async () => ({}), prepareRuntime: async () => ({ run: async () => ({}) }),
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(), initialStatuses: recovered,
  });
  class FakeServer {
    tools = new Map();
    registerTool(name, config, handler) { this.tools.set(name, handler); }
  }
  const server = createGeminiMcpServer({ core, ServerClass: FakeServer });
  const result = await server.tools.get("get_gemini_status")({ job_id: record.jobId });
  assert.deepEqual(result.structuredContent.error, expected);
  assert.equal(JSON.stringify(result).includes("private legacy text"), false);
  assert.equal(result.structuredContent.revision, 1);
  assert.equal(writes, 0);
});

test("persists safe classified gate details and restores them after restart", async () => {
  const files = new Map();
  const store = createJobStateStore({
    stateRoot: "C:\\runtime\\jobs", mkdirPath: async () => {},
    writeFile: async (path, data) => files.set(path, data),
    renamePath: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (path) => {
      if (!files.has(path)) { const error = new Error("missing"); error.code = "ENOENT"; throw error; }
      return files.get(path);
    }, listDirectory: async () => ["job_gate.json"], now: () => "now",
  });
  await store.persist({
    jobId: "job_gate", status: "failed", error: {
      category: "app_server_incompatible", source: "router", code: "app_server_incompatible",
      stage: "router", reason: "router_identity_unavailable", field: "candidate", status: 503,
      message: "secret", rawBody: "secret", unknownCode: "sentinel-untrusted-4829",
      fieldFromCaller: "sentinel-untrusted-4829", reasonFromCaller: "sentinel-untrusted-4829",
    },
  });
  const recovered = await store.reconcile();
  assert.deepEqual(recovered[0].error, {
    category: "app_server_incompatible", source: "router", code: "app_server_incompatible",
    stage: "router", reason: "router_identity_unavailable", field: "candidate", status: 503,
  });
  assert.equal(JSON.stringify(recovered).includes("secret"), false);
  assert.equal(JSON.stringify(recovered).includes("sentinel-untrusted-4829"), false);
  const restarted = createGeminiCompanionCore({
    validateRequest: async () => ({}), prepareRuntime: async () => ({ run: async () => ({}) }),
    workspaceLeases: createWorkspaceLeaseManager(), redactor: createCompanionRedactor(), initialStatuses: recovered,
  });
  assert.deepEqual(restarted.getGeminiStatus("job_gate").error, recovered[0].error);
  assert.equal(JSON.stringify(restarted.getGeminiStatus("job_gate")).includes("sentinel-untrusted-4829"), false);
});
