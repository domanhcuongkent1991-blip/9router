import test from "node:test";
import assert from "node:assert/strict";

import * as installation from "../src/installation.js";

const { readInstallationConfig } = installation;

function environment(overrides = {}) {
  return {
    NINEROUTER_CODEX_APP_SERVER_PATH: "C:\\CodexDesktop\\codex.exe",
    NINEROUTER_CODEX_APP_SERVER_ROOT: "C:\\CodexDesktop",
    NINEROUTER_CODEX_BASELINE_VERSION: "codex-cli 1.0.0",
    NINEROUTER_CODEX_BASELINE_SHA256: "a".repeat(64),
    NINEROUTER_GEMINI_MODEL: "gemini-fixed",
    NINEROUTER_API_KEY: "SECRET",
    NINEROUTER_PERMITTED_WORKSPACES: "D:\\Repo;D:\\Other",
    ...overrides,
  };
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required };
}

function envelope(method, paramsRef, { request = true } = {}) {
  return {
    type: "object",
    required: request ? ["id", "method", "params"] : ["method", "params"],
    properties: {
      ...(request ? { id: { $ref: "#/definitions/RequestId" } } : {}),
      method: { type: "string", enum: [method] },
      params: { $ref: paramsRef },
    },
  };
}

function canonicalSchemaBundle() {
  const definitions = {
    RequestId: { oneOf: [{ type: "integer" }, { type: "string" }] },
    InitializeParams: objectSchema({
      clientInfo: { type: "object" },
      capabilities: { type: "object" },
    }, ["clientInfo"]),
    ModelListParams: objectSchema({
      limit: { type: "integer" },
      includeHidden: { type: "boolean" },
    }),
    ThreadStartParams: objectSchema({
      cwd: { type: "string" },
      model: { type: "string" },
      modelProvider: { type: "string" },
      sandbox: { type: "string" },
      approvalPolicy: { type: "string" },
      ephemeral: { type: "boolean" },
    }),
    ThreadResumeParams: objectSchema({
      threadId: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      modelProvider: { type: "string" },
      sandbox: { type: "string" },
      approvalPolicy: { type: "string" },
    }, ["threadId"]),
    TurnStartParams: objectSchema({
      threadId: { type: "string" },
      input: { type: "array" },
      model: { type: "string" },
      effort: { type: "string" },
    }, ["threadId", "input"]),
    TurnInterruptParams: objectSchema({
      threadId: { type: "string" },
      turnId: { type: "string" },
    }, ["threadId", "turnId"]),
    TurnStartedNotification: objectSchema({
      threadId: { type: "string" },
      turn: { type: "object" },
    }, ["threadId", "turn"]),
    AgentMessageDeltaNotification: objectSchema({
      threadId: { type: "string" },
      turnId: { type: "string" },
      itemId: { type: "string" },
      delta: { type: "string" },
    }, ["threadId", "turnId", "itemId", "delta"]),
    TurnCompletedNotification: objectSchema({
      threadId: { type: "string" },
      turn: { type: "object" },
    }, ["threadId", "turn"]),
    CommandExecutionRequestApprovalParams: objectSchema({
      threadId: { type: "string" },
      turnId: { type: "string" },
      itemId: { type: "string" },
    }, ["threadId", "turnId", "itemId"]),
    FileChangeRequestApprovalParams: objectSchema({
      threadId: { type: "string" },
      turnId: { type: "string" },
      itemId: { type: "string" },
    }, ["threadId", "turnId", "itemId"]),
  };
  definitions.ClientRequest = { oneOf: [
    envelope("initialize", "#/definitions/InitializeParams"),
    envelope("model/list", "#/definitions/ModelListParams"),
    envelope("thread/start", "#/definitions/ThreadStartParams"),
    envelope("thread/resume", "#/definitions/ThreadResumeParams"),
    envelope("turn/start", "#/definitions/TurnStartParams"),
    envelope("turn/interrupt", "#/definitions/TurnInterruptParams"),
  ] };
  definitions.ServerNotification = { oneOf: [
    envelope("turn/started", "#/definitions/TurnStartedNotification", { request: false }),
    envelope("item/agentMessage/delta", "#/definitions/AgentMessageDeltaNotification", { request: false }),
    envelope("turn/completed", "#/definitions/TurnCompletedNotification", { request: false }),
  ] };
  definitions.ServerRequest = { oneOf: [
    envelope("item/commandExecution/requestApproval", "#/definitions/CommandExecutionRequestApprovalParams"),
    envelope("item/fileChange/requestApproval", "#/definitions/FileChangeRequestApprovalParams"),
  ] };
  return { definitions };
}

test("loads only installation-owned routing and workspace settings", () => {
  const config = readInstallationConfig(environment());
  assert.equal(config.executablePath, "C:\\CodexDesktop\\codex.exe");
  assert.equal(config.fixedModel, "gemini-fixed");
  assert.deepEqual(config.permittedWorkspaceRoots, ["D:\\Repo", "D:\\Other"]);
  assert.equal(config.baseline.executableSha256, "a".repeat(64));
});

test("exposes the generated schema loader as a focused compatibility seam", () => {
  assert.equal(typeof installation.readGeneratedSchemas, "function");
});

test("reads the canonical schema bundle without enumerating split schemas", async () => {
  let readDirectoryCalls = 0;
  let requestedPath;
  const result = await installation.readGeneratedSchemas("C:\\generated", {
    readDirectory: async () => {
      readDirectoryCalls += 1;
      return Array.from({ length: 304 }, (_, index) => ({
        name: `split-${index}.json`,
        parentPath: "C:\\generated",
        isFile: () => true,
      }));
    },
    readSchemaFile: async (path) => {
      requestedPath = path;
      return JSON.stringify(canonicalSchemaBundle());
    },
  });

  assert.equal(readDirectoryCalls, 0);
  assert.equal(requestedPath, "C:\\generated\\codex_app_server_protocol.schemas.json");
  assert.equal(result.schemaSubsetCompatible, true);
});

test("fails closed when the canonical generated schema cannot be read", async () => {
  await assert.rejects(
    installation.readGeneratedSchemas("C:\\generated", {
      readDirectory: async () => [{
        name: "codex_app_server_protocol.schemas.json",
        parentPath: "C:\\generated",
        isFile: () => true,
      }],
      readSchemaFile: async () => { throw new Error("raw filesystem detail"); },
    }),
    (error) => error.code === "invalid_installation_configuration"
      && error.details.reason === "required_generated_schema_missing"
      && !JSON.stringify(error).includes("raw filesystem detail"),
  );
});

test("rejects missing, relative, or injectable installation values", () => {
  for (const overrides of [
    { NINEROUTER_CODEX_APP_SERVER_PATH: "codex.exe" },
    { NINEROUTER_CODEX_BASELINE_SHA256: "bad" },
    { NINEROUTER_GEMINI_MODEL: "bad\nmodel" },
    { NINEROUTER_PERMITTED_WORKSPACES: "relative" },
  ]) assert.throws(() => readInstallationConfig(environment(overrides)), { code: "invalid_installation_configuration" });
});

test("entrypoint import does not start stdio", async () => {
  const entry = await import("../src/index.js");
  assert.equal(typeof entry.main, "function");
});
