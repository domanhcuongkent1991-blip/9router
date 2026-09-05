import test from "node:test";
import assert from "node:assert/strict";
import { prepareGeminiJob } from "../src/startup.js";

test("checks compatibility before acquiring a workspace lease", async () => {
  const calls = [];
  const result = await prepareGeminiJob({
    request: { task: "inspect", workspace: "D:\\fixture" },
    validateRequest: async (request) => { calls.push("validate"); return request; },
    compatibilityAdapter: { check: async () => { calls.push("compatibility"); return { status: "compatible", warnings: [] }; } },
    acquireWorkspaceLease: async () => { calls.push("workspace"); return { release: async () => {} }; },
  });
  assert.deepEqual(calls, ["validate", "compatibility", "workspace"]);
  assert.equal(result.compatibility.status, "compatible");
});

test("leaves the workspace untouched when compatibility fails", async () => {
  let workspaceCalls = 0;
  const incompatibility = Object.assign(new Error("unsupported"), { code: "app_server_incompatible" });
  await assert.rejects(() => prepareGeminiJob({
    request: { task: "inspect", workspace: "D:\\fixture" },
    validateRequest: async (request) => request,
    compatibilityAdapter: { check: async () => { throw incompatibility; } },
    acquireWorkspaceLease: async () => { workspaceCalls += 1; return { release: async () => {} }; },
  }), { code: "app_server_incompatible" });
  assert.equal(workspaceCalls, 0);
});
