import test from "node:test";
import assert from "node:assert/strict";

import { createWorkspaceManager } from "../src/workspace.js";

const root = "C:\\tmp\\CodexScratch\\9router-gemini-jobs";

test("resumes only the validated worktree and does not create a replacement", async () => {
  const calls = [];
  const manager = createWorkspaceManager({ worktreeRoot: root,
    mkdirPath: async () => { throw new Error("must not create"); }, lstatPath: async () => ({}),
    realpathPath: async (value) => value,
    execFile: async (_file, args) => {
      calls.push(args);
      return { stdout: args.includes("--git-common-dir") ? "D:\\Repo\\.git" : "a".repeat(40) };
    },
  });
  const workspace = { executionWorkspace: `${root}\\job_old`, worktreePath: `${root}\\job_old`, head: "a".repeat(40) };
  const result = await manager.prepare({ workspace: "D:\\Repo", access: "workspace-write", sessionId: "session_1", resumeContext: workspace }, "job_new");
  assert.deepEqual(result, workspace);
  assert.equal(calls.some((args) => args.includes("add")), false);
  await assert.rejects(manager.prepare({ workspace: "D:\\Repo", access: "read-only", sessionId: "unknown" }, "job_new"));
});

function fixture({ status = "", escaped = false } = {}) {
  const calls = [];
  const manager = createWorkspaceManager({
    worktreeRoot: root,
    mkdirPath: async (...args) => calls.push(["mkdir", ...args]),
    lstatPath: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
    realpathPath: async (value) => escaped && value.includes("job_1") ? "C:\\escape\\job_1" : value,
    execFile: async (file, args, options) => {
      calls.push(["exec", file, args, options]);
      if (args.includes("status")) return { stdout: status };
      if (args.includes("rev-parse")) return { stdout: "a".repeat(40) + "\n" };
      return { stdout: "" };
    },
  });
  return { manager, calls };
}

test("uses canonical source read-only without any git mutation", async () => {
  const { manager, calls } = fixture();
  const result = await manager.prepare({ workspace: "D:\\Repo", access: "read-only" }, "job_1");
  assert.deepEqual(result, { executionWorkspace: "D:\\Repo", worktreePath: null, head: null });
  assert.deepEqual(calls, []);
});

test("checks dirtiness and exact HEAD before safe argv worktree creation", async () => {
  const { manager, calls } = fixture();
  const result = await manager.prepare({ workspace: "D:\\Repo", access: "workspace-write" }, "job_1");
  assert.equal(result.head, "a".repeat(40));
  assert.equal(result.worktreePath, `${root}\\job_1`);
  const git = calls.filter(([kind]) => kind === "exec");
  assert.deepEqual(git.map((entry) => entry.slice(1, 3)), [
    ["git", ["-C", "D:\\Repo", "status", "--porcelain=v1", "-z"]],
    ["git", ["-C", "D:\\Repo", "rev-parse", "--verify", "HEAD"]],
    ["git", ["-C", "D:\\Repo", "worktree", "add", "--detach", `${root}\\job_1`, "a".repeat(40)]],
  ]);
  assert.ok(git.every((entry) => entry[3].shell === false));
});

test("fails dirty or symlink-escaped workspaces without cleanup", async () => {
  await assert.rejects(fixture({ status: " M existing.js\0" }).manager.prepare(
    { workspace: "D:\\Repo", access: "workspace-write" }, "job_1",
  ), { code: "workspace_dirty" });
  const escaped = fixture({ escaped: true });
  await assert.rejects(escaped.manager.prepare(
    { workspace: "D:\\Repo", access: "workspace-write" }, "job_1",
  ), { code: "workspace_prepare_error" });
  assert.equal(escaped.calls.some(([kind, file]) => kind === "exec" && file === "remove"), false);
});

test("returns a bounded deduplicated file list from the retained worktree", async () => {
  const calls = [];
  const manager = createWorkspaceManager({
    worktreeRoot: root, mkdirPath: async () => {}, lstatPath: async () => {}, realpathPath: async (value) => value,
    execFile: async (file, args, options) => {
      calls.push([file, args, options]);
      return { stdout: args.includes("diff") ? "src/a.js\0src/b.js\0" : "src/b.js\0new.txt\0" };
    },
  });
  assert.deepEqual(await manager.collectChanges({
    executionWorkspace: `${root}\\job_1`, worktreePath: `${root}\\job_1`, head: "a".repeat(40),
  }), ["new.txt", "src/a.js", "src/b.js"]);
  assert.deepEqual(calls.map((call) => call[1]), [
    ["-C", `${root}\\job_1`, "diff", "--name-only", "-z", "--no-ext-diff", "a".repeat(40)],
    ["-C", `${root}\\job_1`, "ls-files", "--others", "--exclude-standard", "-z"],
  ]);
});

test("resolves a canonical Git top-level before writer locking", async () => {
  const calls = [];
  const manager = createWorkspaceManager({
    worktreeRoot: root, mkdirPath: async () => {}, lstatPath: async () => {},
    realpathPath: async (value) => value.toLowerCase() === "d:\\repo" ? "D:\\Repo" : value,
    execFile: async (file, args, options) => {
      calls.push([file, args, options]);
      return { stdout: "D:\\Repo\n" };
    },
  });
  assert.deepEqual(await manager.resolveRepository({ workspace: "D:\\Repo\\packages\\app", access: "workspace-write" }), {
    repositoryRoot: "D:\\Repo",
  });
  assert.deepEqual(calls[0][1], ["-C", "D:\\Repo\\packages\\app", "rev-parse", "--show-toplevel"]);
  assert.equal(calls[0][2].shell, false);
});
