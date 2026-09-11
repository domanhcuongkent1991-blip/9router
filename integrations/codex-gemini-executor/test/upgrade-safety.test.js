import test from "node:test";
import assert from "node:assert/strict";
import * as ownership from "../src/execution-owner.js";
import * as qualification from "../src/qualification.js";
import { createSessionStore } from "../src/session-store.js";

test("independent owners exclude each other and preserve a quarantined lock", async () => {
  const files = new Map();
  const io = {
    mkdir: async () => {},
    writeFile: async (path, text, options) => {
      if (options.flag === "wx" && files.has(path)) throw Object.assign(new Error(), { code: "EEXIST" });
      files.set(path, text);
    },
    readFile: async (path) => files.get(path),
    unlink: async (path) => files.delete(path),
  };
  assert.equal(typeof ownership.createExecutionOwner, "function");
  const first = ownership.createExecutionOwner({ directory: "C:\\runtime", io });
  const second = ownership.createExecutionOwner({ directory: "C:\\runtime", io });
  const lease = await first.acquire();
  await assert.rejects(second.acquire(), { code: "workspace_locked" });
  await lease.release();
  const quarantined = await second.acquire();
  await quarantined.quarantine();
  await assert.rejects(first.acquire(), { code: "workspace_locked" });
});

test("session metadata survives restart but cannot cross runtime or workspace", async () => {
  const files = new Map();
  const io = { mkdir: async () => {}, writeFile: async (path, text) => files.set(path, text),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (path) => files.get(path) };
  const request = { workspace: "D:\\Repo", access: "workspace-write", model: "gemini-a" };
  const context = { executionWorkspace: "C:\\scratch\\job_old", worktreePath: "C:\\scratch\\job_old", head: "a".repeat(40) };
  await createSessionStore({ directory: "C:\\sessions", io }).save("session_1", request, "runtime_1", context);
  const restarted = createSessionStore({ directory: "C:\\sessions", io });
  assert.deepEqual(await restarted.load("session_1", request, "runtime_1"), context);
  await assert.rejects(restarted.load("session_1", request, "runtime_2"), { code: "invalid_request" });
  await assert.rejects(restarted.load("session_1", { ...request, workspace: "D:\\Other" }, "runtime_1"));
  await assert.rejects(restarted.load("session_1", { ...request, model: "gemini-b" }, "runtime_1"));
});

test("router identity requires the explicit contract and never follows redirects", async () => {
  let options;
  assert.deepEqual(await qualification.readRouterIdentity({ fetchJson: async (_url, value) => {
    options = value;
    return new Response(JSON.stringify({ version: "0.5.65", buildId: "build_1", contractVersion: 1 }));
  } }), { version: "0.5.65", buildId: "build_1", contractVersion: 1 });
  assert.equal(options.redirect, "error");
  await assert.rejects(qualification.readRouterIdentity({ fetchJson: async () => new Response("{}") }), { code: "app_server_incompatible" });
});

test("qualification rejects missing approval, incomplete evidence and runtime drift", () => {
  assert.equal(typeof qualification.requireQualifiedCombination, "function");
  const identity = { appServer: { path: "C:\\codex.exe", version: "1", sha256: "a".repeat(64) },
    node: { path: "C:\\node.exe", version: "v22" }, companionSha256: "b".repeat(64),
    router: { version: "0.5.65", buildId: "build-1", contractVersion: 1 }, provider: "nine_router",
    model: "ag/gemini-3.8-flash", allowedModels: ["ag/gemini-3.8-flash", "ag/gemini-3.8-pro"] };
  const checks = Object.fromEntries(qualification.REQUIRED_CANARY_CHECKS.map((name) => [name, true]));
  const approval = { schemaVersion: 1, identity, checks, approvedAt: "2026-09-07T00:00:00.000Z" };
  assert.throws(() => qualification.requireQualifiedCombination(identity, null), { code: "app_server_incompatible" });
  assert.ok(qualification.requireQualifiedCombination(identity, approval));
  assert.throws(() => qualification.requireQualifiedCombination({ ...identity, node: { ...identity.node, version: "v24" } }, approval));
  assert.throws(() => qualification.requireQualifiedCombination({ ...identity, allowedModels: [...identity.allowedModels, "ag/gemini-3.9"] }, approval));
  assert.throws(() => qualification.requireQualifiedCombination(identity, { ...approval, checks: { ...checks, resume: false } }));
  assert.throws(() => qualification.requireQualifiedCombination(identity, { ...approval, checks: { ...checks, cancel: false } }));
});
