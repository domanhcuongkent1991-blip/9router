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

test("keeps legacy storage defaults and accepts separate candidate roots", () => {
  const defaults = readInstallationConfig(environment());
  assert.equal(defaults.runtimeRoot, "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime");
  assert.equal(defaults.worktreeRoot, "C:\\tmp\\CodexScratch\\9router-gemini-jobs");
  const candidate = readInstallationConfig(environment({
    NINEROUTER_RUNTIME_ROOT: "C:\\Users\\Admin\\Documents\\Codex\\candidate-runtime",
    NINEROUTER_WORKTREE_ROOT: "C:\\tmp\\CodexScratch\\candidate-jobs",
  }));
  assert.equal(candidate.runtimeRoot, "C:\\Users\\Admin\\Documents\\Codex\\candidate-runtime");
  assert.equal(candidate.worktreeRoot, "C:\\tmp\\CodexScratch\\candidate-jobs");
});

test("rejects unsafe or overlapping storage overrides", () => {
  for (const value of ["", "relative", "C:relative", "\\rooted", "C:\\", "C:\\bad\npath", "\\\\host\\share", "C:\\data:stream"]) {
    assert.throws(() => readInstallationConfig(environment({ NINEROUTER_RUNTIME_ROOT: value })),
      { code: "invalid_installation_configuration" });
  }
  assert.throws(() => readInstallationConfig(environment({
    NINEROUTER_RUNTIME_ROOT: "C:\\candidate",
    NINEROUTER_WORKTREE_ROOT: "c:\\candidate\\jobs",
  })), { code: "invalid_installation_configuration" });
});

test("unqualified runtime blocks execution before child config/schema/worktree writes", async () => {
  const writes = [];
  let releases = 0;
  const core = await installation.createInstalledGeminiCompanion({ environment: environment(), dependencies: {
    listDirectory: async () => [], realpathPath: async (path) => path, statPath: async () => ({ isDirectory: () => true }),
    readFile: async (path) => {
      if (path.endsWith("package-lock.json")) return "{}";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    mkdirPath: async () => {}, writeFile: async (path) => writes.push(path), renamePath: async () => {},
    spawnProcess: () => { throw new Error("must not launch"); },
    observeExecutable: async () => ({ executablePath: "C:\\CodexDesktop\\codex.exe", version: "1", executableSha256: "a".repeat(64) }),
    routerIdentity: async () => ({ version: "0.5.65", buildId: "build_1", contractVersion: 1 }),
    digestSource: async () => "b".repeat(64),
    executionOwner: { acquire: async () => ({ release: async () => { releases++; }, quarantine: async () => {} }) },
  } });
  const result = await core.runGeminiTask({ workspace: "D:\\Repo", task: "test" });
  assert.equal(result.error.category, "app_server_incompatible");
  assert.equal(releases, 1);
  assert.ok(writes.every((path) => path.includes("\\jobs\\") && path.endsWith(".tmp")));
});

test("candidate instances keep job state and qualification reads in their own roots", async () => {
  for (const name of ["candidate-a", "candidate-b"]) {
    const runtimeRoot = `C:\\Canary\\${name}`;
    const touched = [];
    const record = async (path) => { touched.push(path); };
    const core = await installation.createInstalledGeminiCompanion({
      environment: environment({ NINEROUTER_RUNTIME_ROOT: runtimeRoot,
        NINEROUTER_WORKTREE_ROOT: `C:\\CanaryJobs\\${name}` }),
      dependencies: {
        listDirectory: async (path) => { touched.push(path); return []; },
        realpathPath: async path => path, statPath: async () => ({ isDirectory: () => true }),
        readFile: async path => {
          if (path.endsWith("package-lock.json")) return "{}";
          touched.push(path);
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        mkdirPath: record, writeFile: record, renamePath: record,
        spawnProcess: () => { throw new Error("must not launch"); },
        observeExecutable: async () => ({ executablePath: "C:\\CodexDesktop\\codex.exe", version: "1", executableSha256: "a".repeat(64) }),
        routerIdentity: async () => ({ version: "0.5.65", buildId: "build_1", contractVersion: 1 }),
        digestSource: async () => "b".repeat(64),
        executionOwner: { acquire: async () => ({ release: async () => {}, quarantine: async () => {} }) },
      },
    });
    const result = await core.runGeminiTask({ workspace: "D:\\Repo", task: "test" });
    assert.equal(result.error.category, "app_server_incompatible");
    assert.ok(touched.includes(`${runtimeRoot}\\qualified-combination.json`));
    assert.ok(touched.some(path => path.startsWith(`${runtimeRoot}\\jobs`)));
    assert.ok(touched.every(path => path === runtimeRoot || path.startsWith(`${runtimeRoot}\\`)));
  }
});
