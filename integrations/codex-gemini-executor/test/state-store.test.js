import test from "node:test";
import assert from "node:assert/strict";

import { createGeminiCompanionCore } from "../src/core.js";
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

test("reconciles stale nonterminal jobs without killing or deleting anything", async () => {
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
  assert.equal(recovered[0].status, "failed");
  assert.equal(recovered[0].error.category, "protocol_error");
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
