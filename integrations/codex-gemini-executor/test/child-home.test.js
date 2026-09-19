import test from "node:test";
import assert from "node:assert/strict";

import { createChildHomeManager } from "../src/child-home.js";

test("writes model-specific isolated config atomically without credentials or parent capabilities", async () => {
  const writes = [];
  const renames = [];
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {},
    writeFile: async (path, data) => writes.push([path, data]),
    renamePath: async (...args) => renames.push(args),
  });
  const result = await manager.prepare({ PATH: "fixed", NINEROUTER_API_KEY: "SECRET" }, "gemini-fast");
  assert.equal(result.environment.NINEROUTER_GEMINI_CHILD, "1");
  assert.equal(result.environment.NINEROUTER_API_KEY, "SECRET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].includes("SECRET"), false);
  assert.match(writes[0][1], /^model = "gemini-fast"$/mu);
  assert.match(writes[0][1], /^approval_policy = "on-request"$/mu);
  assert.match(writes[0][1], /env_key = "NINEROUTER_API_KEY"/u);
  assert.match(writes[0][1], /wire_api = "responses"/u);
  assert.match(writes[0][1], /^web_search = "disabled"$/mu);
  assert.match(writes[0][1], /sandbox_mode = "read-only"/u);
  assert.match(writes[0][1], /network_access = false/u);
  assert.match(writes[0][1], /requires_openai_auth = false/u);
  assert.match(writes[0][1], /request_max_retries = 1/u);
  assert.match(writes[0][1], /stream_max_retries = 1/u);
  assert.match(writes[0][1], /stream_idle_timeout_ms = 300000/u);
  assert.equal(/mcp_servers|plugin|auth_token/u.test(writes[0][1]), false);
  assert.equal(renames.length, 1);
});

test("uses the non-interactive approval policy for read-only analysis", async () => {
  const writes = [];
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {},
    writeFile: async (_path, data) => writes.push(data),
    renamePath: async () => {},
  });
  await manager.prepare({ PATH: "fixed" }, "gemini-fast", "never");
  assert.match(writes[0], /^approval_policy = "never"$/mu);
});

test("prevents recursive companion execution", async () => {
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {}, writeFile: async () => {}, renamePath: async () => {},
  });
  await assert.rejects(manager.prepare({ NINEROUTER_GEMINI_CHILD: "1" }, "gemini-fast"), { code: "recursive_child_blocked" });
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
  const first = manager.prepare({ PATH: "fixed" }, "gemini-first");
  const second = manager.prepare({ PATH: "fixed" }, "gemini-second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(release.length, 1);
  release.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(release.length, 1);
  release.shift()();
  await Promise.all([first, second]);
  assert.equal(maximumActiveWrites, 1);
});

test("rejects an unsafe per-job model before writing child configuration", async () => {
  let writes = 0;
  const manager = createChildHomeManager({
    runtimeRoot: "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    mkdirPath: async () => {}, writeFile: async () => { writes += 1; }, renamePath: async () => {},
  });
  await assert.rejects(manager.prepare({ PATH: "fixed" }, "unsafe\nmodel"), { code: "child_home_error" });
  assert.equal(writes, 0);
});
