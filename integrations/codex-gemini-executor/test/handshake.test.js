import test from "node:test";
import assert from "node:assert/strict";

import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import {
  AppServerHandshakeError,
  createStableHandshakeDriver,
} from "../src/app-server/handshake.js";

const clientInfo = {
  name: "nine_router_gemini",
  title: "9Router Gemini",
  version: "0.1.0",
};
const initializeResponse = {
  userAgent: "codex-cli/0.153.4",
  platformFamily: "windows",
  platformOs: "windows",
  codexHome: "C:\\IsolatedCodexHome",
};
const methods = () => Object.fromEntries(APP_SERVER_REQUIRED_METHODS.map((name) => [name, true]));

function fixture({ response = initializeResponse, modelResponse = { data: [] }, schemaQualification } = {}) {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push(["request", method, params]);
      if (method === "initialize") return response;
      if (method === "model/list") return modelResponse;
      throw new Error("unexpected method");
    },
    notify(method, params) {
      calls.push(["notify", method, params]);
    },
  };
  const driver = createStableHandshakeDriver({
    client,
    schemaQualification: schemaQualification ?? {
      schemaSubsetCompatible: true,
      methods: methods(),
    },
  });
  return { calls, client, driver };
}

test("awaits initialize before notifying and returns sanitized results", async () => {
  let resolveInitialize;
  const calls = [];
  const client = {
    request(method, params) {
      calls.push(["request", method, params]);
      if (method === "model/list") return Promise.resolve({ data: [] });
      return new Promise((resolve) => { resolveInitialize = resolve; });
    },
    notify(method, params) { calls.push(["notify", method, params]); },
  };
  const driver = createStableHandshakeDriver({
    client,
    schemaQualification: { schemaSubsetCompatible: true, methods: methods() },
  });
  const pending = driver.initialize({ clientInfo, capabilities: { experimentalApi: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  resolveInitialize(initializeResponse);
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(calls.map((entry) => entry.slice(0, 2)), [
    ["request", "initialize"],
    ["notify", "initialized"],
  ]);
  assert.equal(JSON.stringify(await driver.probeRequiredContract()).includes("codex-cli"), false);
});

test("rejects malformed initialize responses", async () => {
  for (const response of [
    null,
    { ...initializeResponse, userAgent: "" },
    { ...initializeResponse, platformFamily: 1 },
    { ...initializeResponse, platformOs: "x".repeat(4097) },
    { ...initializeResponse, codexHome: "relative-home" },
  ]) {
    const { driver } = fixture({ response });
    await assert.rejects(
      driver.initialize({ clientInfo, capabilities: { experimentalApi: false } }),
      { code: "app_server_handshake_error", details: { reason: "invalid_initialize_response", stage: "initialize" } },
    );
  }
});

test("rejects experimental or unsupported client capabilities before transport use", async () => {
  for (const capabilities of [
    { experimentalApi: true },
    { experimentalApi: false, unsupported: true },
  ]) {
    const { driver, calls } = fixture();
    await assert.rejects(driver.initialize({ clientInfo, capabilities }), {
      code: "app_server_handshake_error",
      details: { reason: "invalid_initialize_request", stage: "initialize" },
    });
    assert.deepEqual(calls, []);
  }
});

test("a failed initialize never notifies and permanently prevents probing", async () => {
  const { driver, calls } = fixture({ response: { raw: "sensitive" } });
  await assert.rejects(driver.initialize({ clientInfo, capabilities: { experimentalApi: false } }));
  assert.equal(calls.some((entry) => entry[0] === "notify"), false);
  await assert.rejects(driver.probeRequiredContract(), {
    code: "app_server_handshake_error",
    details: { reason: "initialize_required", stage: "probe" },
  });
});

test("uses model/list as the only read-only live probe and accepts no configured models", async () => {
  const { driver, calls } = fixture();
  await driver.initialize({ clientInfo, capabilities: { experimentalApi: false } });
  const result = await driver.probeRequiredContract();
  assert.deepEqual(calls.filter((entry) => entry[0] === "request").map((entry) => entry.slice(1)), [
    ["initialize", { clientInfo, capabilities: { experimentalApi: false } }],
    ["model/list", { limit: 1, includeHidden: true }],
  ]);
  assert.deepEqual(result, { schemaSubsetCompatible: true, methods: methods() });
});

test("sanitizes invalid probe state, model response, and schema qualification", async () => {
  const beforeInitialize = fixture().driver;
  await assert.rejects(beforeInitialize.probeRequiredContract(), (error) => {
    assert.ok(error instanceof AppServerHandshakeError);
    assert.equal(error.details.reason, "initialize_required");
    return true;
  });

  for (const options of [
    { modelResponse: { data: "sensitive raw model" } },
    { schemaQualification: { schemaSubsetCompatible: true, methods: { "model/list": true } } },
  ]) {
    const { driver } = fixture(options);
    await driver.initialize({ clientInfo, capabilities: { experimentalApi: false } });
    await assert.rejects(driver.probeRequiredContract(), (error) => {
      assert.equal(error.code, "app_server_handshake_error");
      assert.equal(JSON.stringify(error).includes("sensitive raw model"), false);
      return true;
    });
  }
});
