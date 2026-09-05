import test from "node:test";
import assert from "node:assert/strict";
import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import { createAppServerCompatibilityAdapter } from "../src/app-server/adapter.js";
import { createStableHandshakeDriver } from "../src/app-server/handshake.js";
import { combineSchemaQualifications, qualifyApprovalSchemaBundle, qualifyStableSchemaBundle } from "../src/app-server/schema-qualification.js";

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

test("does not probe after a failed handshake", async () => {
  let probeCalls = 0;
  const adapter = createAppServerCompatibilityAdapter(options({
    initialize: async () => ({ ok: false }),
    probeRequiredContract: async () => { probeCalls += 1; return { schemaSubsetCompatible: true, methods: methods() }; },
  }));
  await assert.rejects(() => adapter.check(), { code: "app_server_incompatible" });
  assert.equal(probeCalls, 0);
});

test("does not let warning delivery block compatible execution", async () => {
  const adapter = createAppServerCompatibilityAdapter(options({ onWarning: () => { throw new Error("warning sink detail"); } }));
  const result = await adapter.check();
  assert.equal(result.status, "compatible");
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["codex_version_changed", "codex_executable_changed"]);
});

test("absorbs rejected asynchronous warning delivery", async () => {
  const adapter = createAppServerCompatibilityAdapter(options({
    onWarning: async () => {
      throw new Error("sensitive asynchronous warning failure");
    },
  }));
  const result = await adapter.check();
  assert.equal(result.status, "compatible");
  await new Promise((resolve) => setImmediate(resolve));
});

function generatedSchema({ includeInterrupt = true, includeCompleted = true } = {}) {
  const refs = {
    initialize: "#/definitions/InitializeParams",
    "model/list": "#/definitions/ModelListParams",
    "thread/start": "#/definitions/ThreadStartParams",
    "thread/resume": "#/definitions/ThreadResumeParams",
    "turn/start": "#/definitions/TurnStartParams",
    ...(includeInterrupt ? { "turn/interrupt": "#/definitions/TurnInterruptParams" } : {}),
  };
  const objectDefinition = (properties, required = []) => ({ type: "object", properties, required });
  return {
    definitions: {
      RequestId: { oneOf: [{ type: "integer" }, { type: "string" }] },
      InitializeParams: objectDefinition({ clientInfo: { type: "object" }, capabilities: { type: "object" } }, ["clientInfo"]),
      ModelListParams: objectDefinition({ limit: { type: "integer" }, includeHidden: { type: "boolean" } }),
      ThreadStartParams: objectDefinition({
        cwd: { type: "string" }, model: { type: "string" }, modelProvider: { type: "string" },
        sandbox: { type: "string" }, approvalPolicy: { type: "string" }, ephemeral: { type: "boolean" },
      }),
      ThreadResumeParams: objectDefinition({
        threadId: { type: "string" }, cwd: { type: "string" }, model: { type: "string" },
        modelProvider: { type: "string" }, sandbox: { type: "string" }, approvalPolicy: { type: "string" },
      }, ["threadId"]),
      TurnStartParams: objectDefinition({
        threadId: { type: "string" }, input: { type: "array" }, model: { type: "string" }, effort: { type: "string" },
      }, ["threadId", "input"]),
      TurnInterruptParams: objectDefinition({ threadId: { type: "string" }, turnId: { type: "string" } }, ["threadId", "turnId"]),
      TurnStartedNotification: objectDefinition({ threadId: { type: "string" }, turn: { type: "object" } }, ["threadId", "turn"]),
      AgentMessageDeltaNotification: objectDefinition({
        threadId: { type: "string" }, turnId: { type: "string" }, itemId: { type: "string" }, delta: { type: "string" },
      }, ["threadId", "turnId", "itemId", "delta"]),
      TurnCompletedNotification: objectDefinition({ threadId: { type: "string" }, turn: { type: "object" } }, ["threadId", "turn"]),
      ClientRequest: {
        oneOf: Object.entries(refs).map(([method, ref]) => ({
          required: ["id", "method", "params"],
          properties: {
            id: { $ref: "#/definitions/RequestId" },
            method: { type: "string", enum: [method] },
            params: { $ref: ref },
          },
        })),
      },
      ServerNotification: {
        oneOf: [
          ["turn/started", "#/definitions/TurnStartedNotification"],
          ["item/agentMessage/delta", "#/definitions/AgentMessageDeltaNotification"],
          ...(includeCompleted ? [["turn/completed", "#/definitions/TurnCompletedNotification"]] : []),
        ].map(([method, ref]) => ({
          required: ["method", "params"],
          properties: { method: { type: "string", enum: [method] }, params: { $ref: ref } },
        })),
      },
    },
  };
}

function generatedApprovalSchema({ includeFileChange = true } = {}) {
  const approvalDefinition = () => ({
    type: "object",
    properties: { threadId: { type: "string" }, turnId: { type: "string" }, itemId: { type: "string" } },
    required: ["threadId", "turnId", "itemId"],
  });
  return {
    definitions: {
      v2: { RequestId: { oneOf: [{ type: "integer" }, { type: "string" }] } },
      CommandExecutionRequestApprovalParams: approvalDefinition(),
      FileChangeRequestApprovalParams: approvalDefinition(),
      ServerRequest: {
        oneOf: [
          ["item/commandExecution/requestApproval", "#/definitions/CommandExecutionRequestApprovalParams"],
          ...(includeFileChange ? [["item/fileChange/requestApproval", "#/definitions/FileChangeRequestApprovalParams"]] : []),
        ].map(([method, ref]) => ({
          required: ["id", "method", "params"],
          properties: { id: { $ref: "#/definitions/v2/RequestId" }, method: { type: "string", enum: [method] }, params: { $ref: ref } },
        })),
      },
    },
  };
}

function composedAdapter({ includeInterrupt = true, includeCompleted = true, includeFileChange = true } = {}) {
  const warnings = [];
  const client = {
    async request(method) {
      if (method === "initialize") {
        return {
          userAgent: "new-version",
          platformFamily: "windows",
          platformOs: "windows",
          codexHome: "C:\\IsolatedCodexHome",
        };
      }
      if (method === "model/list") return { data: [] };
      throw new Error("unexpected probe");
    },
    notify() {},
  };
  const driver = createStableHandshakeDriver({
    client,
    schemaQualification: combineSchemaQualifications(
      qualifyStableSchemaBundle(generatedSchema({ includeInterrupt, includeCompleted })),
      qualifyApprovalSchemaBundle(generatedApprovalSchema({ includeFileChange })),
    ),
  });
  return {
    warnings,
    adapter: createAppServerCompatibilityAdapter({
      baseline: { version: "1.1.0", executableSha256: "b".repeat(64) },
      clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
      observeExecutable: async () => ({ version: "1.2.0", executableSha256: "a".repeat(64) }),
      initialize: driver.initialize,
      probeRequiredContract: driver.probeRequiredContract,
      onWarning: (warning) => warnings.push(warning.code),
    }),
  };
}

test("composition gates on capabilities while version and hash changes only warn", async () => {
  const compatible = composedAdapter();
  assert.equal((await compatible.adapter.check()).status, "compatible");
  assert.deepEqual(compatible.warnings, ["codex_version_changed", "codex_executable_changed"]);

  const incompatible = composedAdapter({ includeInterrupt: false });
  await assert.rejects(incompatible.adapter.check(), (error) => {
    assert.equal(error.code, "app_server_incompatible");
    assert.deepEqual(error.details.missingCapabilities, ["turn/interrupt"]);
    return true;
  });
});

test("composition fails closed when required notifications or approval requests are absent", async () => {
  await assert.rejects(composedAdapter({ includeCompleted: false }).adapter.check(), { code: "app_server_incompatible" });
  await assert.rejects(composedAdapter({ includeFileChange: false }).adapter.check(), { code: "app_server_incompatible" });
});
