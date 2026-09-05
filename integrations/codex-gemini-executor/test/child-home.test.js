import test from "node:test";
import assert from "node:assert/strict";

import { createChildHomeManager } from "../src/child-home.js";

test("writes fixed isolated config atomically without credentials or parent capabilities", async () => {
  const writes = [];
  const renames = [];
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {},
    writeFile: async (path, data) => writes.push([path, data]),
    renamePath: async (...args) => renames.push(args),
  });
  const result = await manager.prepare({ PATH: "fixed", NINEROUTER_API_KEY: "SECRET" });
  assert.equal(result.environment.NINEROUTER_GEMINI_CHILD, "1");
  assert.equal(result.environment.NINEROUTER_API_KEY, "SECRET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].includes("SECRET"), false);
  assert.match(writes[0][1], /env_key = "NINEROUTER_API_KEY"/u);
  assert.match(writes[0][1], /wire_api = "responses"/u);
  assert.match(writes[0][1], /sandbox_mode = "read-only"/u);
  assert.match(writes[0][1], /network_access = false/u);
  assert.equal(/mcp_servers|plugin|auth/u.test(writes[0][1]), false);
  assert.equal(renames.length, 1);
});

test("prevents recursive companion execution", async () => {
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {}, writeFile: async () => {}, renamePath: async () => {},
  });
  await assert.rejects(manager.prepare({ NINEROUTER_GEMINI_CHILD: "1" }), { code: "recursive_child_blocked" });
});
