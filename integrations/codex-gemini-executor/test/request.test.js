import test from "node:test";
import assert from "node:assert/strict";

import { CompanionRequestError, validateGeminiRequest } from "../src/request.js";

function filesystemFixture({
  workspace = "D:\\Repo",
  root = "D:\\Repo",
  defaultModel = "gemini-fixed",
  allowedModels = [defaultModel],
} = {}) {
  const canonical = new Map([
    [workspace, "D:\\Repo"],
    [root, "D:\\Repo"],
  ]);
  return {
    permittedWorkspaceRoots: [root],
    defaultModel,
    allowedModels,
    realpathPath: async (value) => canonical.get(value) ?? value,
    statPath: async () => ({ isDirectory: () => true }),
  };
}

test("normalizes defaults and canonical workspace without mutating the request", async () => {
  const request = { task: "  inspect the repository  ", workspace: "D:\\Repo" };
  const output = await validateGeminiRequest(request, filesystemFixture());
  assert.deepEqual(output, {
    task: "inspect the repository",
    workspace: "D:\\Repo",
    effort: "medium",
    access: "read-only",
    model: "gemini-fixed",
    timeoutMinutes: 30,
  });
  assert.deepEqual(request, { task: "  inspect the repository  ", workspace: "D:\\Repo" });
  assert.equal(Object.isFrozen(output), true);
});

test("accepts the bounded supported request contract", async () => {
  const output = await validateGeminiRequest({
    task: "change one file",
    workspace: "D:\\Repo",
    effort: "high",
    access: "workspace-write",
    session_id: "session_1",
    timeout_minutes: 120,
    model: "gemini-fast",
  }, filesystemFixture({ allowedModels: ["gemini-fixed", "gemini-fast"] }));
  assert.equal(output.sessionId, "session_1");
  assert.equal(output.timeoutMinutes, 120);
  assert.equal(output.model, "gemini-fast");
});

test("rejects an unallowlisted model before filesystem access", async () => {
  let filesystemCalls = 0;
  await assert.rejects(validateGeminiRequest({ task: "x", workspace: "D:\\Repo", model: "gemini-other" }, {
    ...filesystemFixture({ allowedModels: ["gemini-fixed", "gemini-fast"] }),
    realpathPath: async () => { filesystemCalls += 1; return "D:\\Repo"; },
  }), { code: "invalid_request", details: { field: "model", reason: "not_allowed" } });
  assert.equal(filesystemCalls, 0);
});

test("rejects unsupported values, caller routing fields, and oversized inputs before filesystem access", async () => {
  const invalid = [
    { task: "", workspace: "D:\\Repo" },
    { task: "x".repeat(64 * 1024 + 1), workspace: "D:\\Repo" },
    { task: `x${" ".repeat(64 * 1024 + 1)}`, workspace: "D:\\Repo" },
    { task: "x", workspace: "relative" },
    { task: "x", workspace: "D:\\Repo", effort: "xhigh" },
    { task: "x", workspace: "D:\\Repo", access: "danger-full-access" },
    { task: "x", workspace: "D:\\Repo", session_id: "x".repeat(513) },
    { task: "x", workspace: "D:\\Repo", session_id: `s${" ".repeat(513)}` },
    { task: "x", workspace: "D:\\Repo", timeout_minutes: 0 },
    { task: "x", workspace: "D:\\Repo", timeout_minutes: 121 },
    { task: "x", workspace: "D:\\Repo", model: "other" },
    { task: "x", workspace: "D:\\Repo", provider_url: "https://example.invalid" },
  ];
  for (const request of invalid) {
    let filesystemCalls = 0;
    await assert.rejects(validateGeminiRequest(request, {
      ...filesystemFixture(),
      realpathPath: async () => { filesystemCalls += 1; return "D:\\Repo"; },
    }), CompanionRequestError);
    assert.equal(filesystemCalls, 0);
  }
});

test("fails closed for missing, non-directory, and canonically escaped workspaces", async () => {
  await assert.rejects(validateGeminiRequest({ task: "x", workspace: "D:\\Repo" }, {
    permittedWorkspaceRoots: ["D:\\Allowed"],
    realpathPath: async (value) => value === "D:\\Repo" ? "D:\\Elsewhere" : "D:\\Allowed",
    statPath: async () => ({ isDirectory: () => true }),
  }), { code: "invalid_request", details: { field: "workspace", reason: "outside_permitted_roots" } });

  await assert.rejects(validateGeminiRequest({ task: "x", workspace: "D:\\Repo" }, {
    ...filesystemFixture(),
    statPath: async () => ({ isDirectory: () => false }),
  }), { code: "invalid_request", details: { field: "workspace", reason: "not_directory" } });

  await assert.rejects(validateGeminiRequest({ task: "x", workspace: "D:\\Repo" }, {
    ...filesystemFixture(),
    realpathPath: async () => { throw new Error("sensitive path detail"); },
  }), (error) => error.code === "invalid_request"
    && error.details.reason === "workspace_unavailable"
    && !JSON.stringify(error).includes("sensitive path detail"));
});
