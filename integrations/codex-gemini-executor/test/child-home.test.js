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
  assert.match(writes[0][1], /requires_openai_auth = false/u);
  assert.match(writes[0][1], /request_max_retries = 1/u);
  assert.match(writes[0][1], /stream_max_retries = 1/u);
  assert.match(writes[0][1], /stream_idle_timeout_ms = 300000/u);
  assert.equal(/mcp_servers|plugin|auth_token/u.test(writes[0][1]), false);
  assert.equal(renames.length, 1);
});

test("prevents recursive companion execution", async () => {
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {}, writeFile: async () => {}, renamePath: async () => {},
  });
  await assert.rejects(manager.prepare({ NINEROUTER_GEMINI_CHILD: "1" }), { code: "recursive_child_blocked" });
});

test("serializes shared config preparation so temporary writes cannot race", async () => {
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const release = [];
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {},
    writeFile: async () => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise((resolve) => release.push(resolve));
      activeWrites -= 1;
    },
    renamePath: async () => {},
  });
  const first = manager.prepare({ PATH: "fixed" });
  const second = manager.prepare({ PATH: "fixed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(release.length, 1);
  release.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(release.length, 1);
  release.shift()();
  await Promise.all([first, second]);
  assert.equal(maximumActiveWrites, 1);
});
