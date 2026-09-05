import test from "node:test";
import assert from "node:assert/strict";
import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import { createAppServerCompatibilityAdapter } from "../src/app-server/adapter.js";

const methods = () => Object.fromEntries(APP_SERVER_REQUIRED_METHODS.map((name) => [name, true]));
const options = (overrides = {}) => ({
  baseline: { version: "1.1.0", executableSha256: "b".repeat(64) },
  clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
  observeExecutable: async () => ({ version: "1.2.0", executableSha256: "a".repeat(64) }),
  initialize: async () => ({ ok: true }),
  probeRequiredContract: async () => ({ schemaSubsetCompatible: true, methods: methods() }),
  ...overrides,
});

test("runs observation, stable handshake, and read-only probes in order", async () => {
  const calls = []; const warnings = [];
  const adapter = createAppServerCompatibilityAdapter(options({
    observeExecutable: async () => { calls.push("observe"); return { version: "1.2.0", executableSha256: "a".repeat(64) }; },
    initialize: async (request) => { calls.push("initialize"); assert.equal(request.capabilities.experimentalApi, false); return { ok: true }; },
    probeRequiredContract: async () => { calls.push("probe"); return { schemaSubsetCompatible: true, methods: methods() }; },
    onWarning: (warning) => warnings.push(warning.code),
  }));
  assert.equal((await adapter.check()).status, "compatible");
  assert.deepEqual(calls, ["observe", "initialize", "probe"]);
  assert.deepEqual(warnings, ["codex_version_changed", "codex_executable_changed"]);
});

test("does not retry after an incompatible probe", async () => {
  let probes = 0; const bad = methods(); bad["thread/start"] = false;
  const adapter = createAppServerCompatibilityAdapter(options({ probeRequiredContract: async () => { probes += 1; return { schemaSubsetCompatible: true, methods: bad }; } }));
  await assert.rejects(() => adapter.check(), { code: "app_server_incompatible" });
  assert.equal(probes, 1);
});

test("normalizes transport failures without exposing their message", async () => {
  const adapter = createAppServerCompatibilityAdapter(options({ initialize: async () => { throw new Error("credential-like transport detail"); } }));
  await assert.rejects(() => adapter.check(), (error) => error.code === "app_server_incompatible" && error.details.stage === "initialize" && !JSON.stringify(error.details).includes("credential-like"));
});
