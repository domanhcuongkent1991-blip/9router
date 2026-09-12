import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { prepareAppServerRuntime } from "./app-server/runtime.js";
import { observeConfiguredExecutable } from "./app-server/executable.js";
import { generateStableSchemaBundle, readExecutableVersion } from "./app-server/process.js";
import {
  combineSchemaQualifications,
  qualifyApprovalSchemaBundle,
  qualifyStableSchemaBundle,
} from "./app-server/schema-qualification.js";
import { createChildHomeManager } from "./child-home.js";
import { createGeminiCompanionCore } from "./core.js";
import { createCompanionRedactor } from "./redaction.js";
import { isSafeModelIdentifier, validateGeminiRequest } from "./request.js";
import { createJobStateStore } from "./state-store.js";
import { createWorkspaceLeaseManager } from "./workspace-lease.js";
import { createWorkspaceManager } from "./workspace.js";
import { createExecutionOwner } from "./execution-owner.js";
import { createSessionStore } from "./session-store.js";
import { readRouterIdentity, requireQualifiedCombination, sourceDigest } from "./qualification.js";
import { AppServerCompatibilityError } from "./app-server/compatibility.js";

const RUNTIME_ROOT = "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime";
const WORKTREE_ROOT = "C:\\tmp\\CodexScratch\\9router-gemini-jobs";
const APP_SERVER_SCHEMA_BUNDLE = "codex_app_server_protocol.schemas.json";
const MAX_GENERATED_SCHEMA_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const execFile = promisify(execFileCallback);

export async function observeInstalledCombination(config, { read = readFile, observe = observeConfiguredExecutable,
  routerIdentity = readRouterIdentity, digestSource = sourceDigest } = {}) {
  const observation = await observe({ executablePath: config.executablePath,
    allowedExecutableRoot: config.allowedExecutableRoot, realpathPath: realpath, statPath: stat,
    createInputStream: createReadStream, readVersion: (path) => readExecutableVersion({ executablePath: path, spawnProcess: spawn }) });
  const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
  const identity = {
    appServer: { path: observation.executablePath, version: observation.version, sha256: observation.executableSha256 },
    node: { path: process.execPath, version: process.version },
    companionSha256: await digestSource(sourceDirectory),
    dependencyLockSha256: createHash("sha256").update(await read(win32.join(sourceDirectory, "..", "package-lock.json"))).digest("hex"),
    router: await routerIdentity(),
    provider: "nine_router",
    model: config.fixedModel,
    allowedModels: config.allowedModels,
  };
  return { observation, identity };
}

export class InstallationConfigError extends Error {
  constructor(reason) {
    super("Gemini companion installation is not configured");
    this.name = "InstallationConfigError";
    this.code = "invalid_installation_configuration";
    this.details = { reason };
  }
}

function required(environment, name, maxBytes = 4096) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new InstallationConfigError(`missing_${name.toLowerCase()}`);
  }
  return value.trim();
}

function storageRoot(environment, name, fallback) {
  const value = environment[name] === undefined ? fallback : required(environment, name);
  if (!/^[A-Za-z]:[\\/]/u.test(value) || /[\x00-\x1f<>"|?*]/u.test(value)
    || value.slice(2).includes(":")) throw new InstallationConfigError("invalid_storage_root");
  const normalized = win32.normalize(value).replace(/[\\/]+$/u, "");
  if (normalized.length <= 2 || normalized.split("\\").slice(1).some((part) => /[. ]$/u.test(part))) {
    throw new InstallationConfigError("invalid_storage_root");
  }
  return normalized;
}

function modelAllowlist(environment, defaultModel) {
  if (environment.NINEROUTER_GEMINI_MODELS === undefined) return Object.freeze([defaultModel]);
  const raw = environment.NINEROUTER_GEMINI_MODELS;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 16 * 1024) {
    throw new InstallationConfigError("invalid_model_allowlist");
  }
  const models = raw.split(";").map((value) => value.trim());
  if (models.length === 0 || models.length > 64 || models.some((model) => !isSafeModelIdentifier(model))
    || new Set(models).size !== models.length || !models.includes(defaultModel)) {
    throw new InstallationConfigError("invalid_model_allowlist");
  }
  return Object.freeze([...models].sort((left, right) => left.localeCompare(right, "en")));
}

export function readInstallationConfig(environment = process.env) {
  const runtimeRoot = storageRoot(environment, "NINEROUTER_RUNTIME_ROOT", RUNTIME_ROOT);
  const worktreeRoot = storageRoot(environment, "NINEROUTER_WORKTREE_ROOT", WORKTREE_ROOT);
  const runtimeKey = runtimeRoot.toLowerCase();
  const worktreeKey = worktreeRoot.toLowerCase();
  if (runtimeKey === worktreeKey || runtimeKey.startsWith(`${worktreeKey}\\`)
    || worktreeKey.startsWith(`${runtimeKey}\\`)) throw new InstallationConfigError("overlapping_storage_roots");
  const executablePath = required(environment, "NINEROUTER_CODEX_APP_SERVER_PATH");
  const allowedExecutableRoot = required(environment, "NINEROUTER_CODEX_APP_SERVER_ROOT");
  const version = required(environment, "NINEROUTER_CODEX_BASELINE_VERSION", 4096);
  const executableSha256 = required(environment, "NINEROUTER_CODEX_BASELINE_SHA256", 64).toLowerCase();
  const fixedModel = required(environment, "NINEROUTER_GEMINI_MODEL", 256);
  const allowedModels = modelAllowlist(environment, fixedModel);
  const apiKey = required(environment, "NINEROUTER_API_KEY", 16 * 1024);
  const roots = required(environment, "NINEROUTER_PERMITTED_WORKSPACES", 32 * 1024)
    .split(";").map((value) => value.trim()).filter(Boolean);
  if (!win32.isAbsolute(executablePath) || !win32.isAbsolute(allowedExecutableRoot)
    || !SHA256.test(executableSha256) || !isSafeModelIdentifier(fixedModel)
    || roots.length === 0 || roots.length > 64 || roots.some((root) => !win32.isAbsolute(root))) {
    throw new InstallationConfigError("invalid_value");
  }
  return Object.freeze({ executablePath, allowedExecutableRoot, fixedModel, allowedModels, apiKey, runtimeRoot, worktreeRoot, permittedWorkspaceRoots: roots,
    baseline: Object.freeze({ version, executableSha256 }) });
}

function childEnvironment(environment, apiKey) {
  const output = { NINEROUTER_API_KEY: apiKey };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT"]) {
    if (typeof environment[key] === "string") output[key] = environment[key];
  }
  return output;
}

export async function readGeneratedSchemas(directory, { readSchemaFile = readFile } = {}) {
  let raw;
  try {
    raw = await readSchemaFile(win32.join(directory, APP_SERVER_SCHEMA_BUNDLE), "utf8");
  } catch {
    throw new InstallationConfigError("required_generated_schema_missing");
  }
  if (typeof raw !== "string") throw new InstallationConfigError("invalid_generated_schema_json");
  if (Buffer.byteLength(raw, "utf8") > MAX_GENERATED_SCHEMA_BYTES) {
    throw new InstallationConfigError("generated_schema_too_large");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new InstallationConfigError("invalid_generated_schema_json"); }
  if (!parsed?.definitions?.ClientRequest || !parsed?.definitions?.ServerRequest) {
    throw new InstallationConfigError("required_generated_schema_missing");
  }
  return combineSchemaQualifications(
    qualifyStableSchemaBundle(parsed),
    qualifyApprovalSchemaBundle(parsed),
  );
}

export async function createInstalledGeminiCompanion({ environment = process.env, dependencies = {} } = {}) {
  const config = readInstallationConfig(environment);
  const fsApi = {
    mkdirPath: dependencies.mkdirPath ?? mkdir,
    writeFile: dependencies.writeFile ?? writeFile,
    renamePath: dependencies.renamePath ?? rename,
    readFile: dependencies.readFile ?? readFile,
    listDirectory: dependencies.listDirectory ?? readdir,
    realpathPath: dependencies.realpathPath ?? realpath,
    statPath: dependencies.statPath ?? stat,
    lstatPath: dependencies.lstatPath ?? lstat,
  };
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const execFileSafe = dependencies.execFile ?? execFile;
  const stateStore = createJobStateStore({ stateRoot: win32.join(config.runtimeRoot, "jobs"), ...fsApi });
  const recovered = await stateStore.reconcile();
  const redactor = createCompanionRedactor({ knownSecrets: [config.apiKey] });
  const childHome = createChildHomeManager({ runtimeRoot: config.runtimeRoot, ...fsApi });
  const workspaceManager = createWorkspaceManager({ worktreeRoot: config.worktreeRoot, execFile: execFileSafe, ...fsApi });
  const executionOwner = dependencies.executionOwner ?? createExecutionOwner({ directory: config.runtimeRoot });
  const sessions = dependencies.sessions ?? createSessionStore({ directory: win32.join(config.runtimeRoot, "sessions") });
  const observe = dependencies.observeExecutable ?? (() => observeConfiguredExecutable({
    executablePath: config.executablePath, allowedExecutableRoot: config.allowedExecutableRoot,
    realpathPath: fsApi.realpathPath, statPath: fsApi.statPath,
    createInputStream: dependencies.createInputStream ?? createReadStream,
    readVersion: (path) => readExecutableVersion({ executablePath: path, spawnProcess }),
  }));
  let currentQualification;
  async function qualify() {
    const { observation, identity } = await observeInstalledCombination(config, {
      observe, read: fsApi.readFile,
      routerIdentity: dependencies.routerIdentity ?? readRouterIdentity,
      digestSource: dependencies.digestSource ?? sourceDigest,
    });
    let approval;
    try {
      const text = await fsApi.readFile(win32.join(config.runtimeRoot, "qualified-combination.json"), "utf8");
      if (Buffer.byteLength(text) > 16384) throw new Error();
      approval = JSON.parse(text);
    } catch {
      throw new AppServerCompatibilityError({ stage: "qualification", reason: "qualification_record_missing" });
    }
    return { observation, fingerprint: requireQualifiedCombination(identity, approval) };
  }

  const prepareRuntime = async ({ jobId, request }) => {
    currentQualification = await qualify();
    if (request.sessionId) request.resumeContext = await sessions.load(request.sessionId, request, currentQualification.fingerprint);
    const isolated = await childHome.prepare(childEnvironment(environment, config.apiKey), request.model);
    const schemaDirectory = win32.join(config.worktreeRoot, `${jobId}-schema`);
    return prepareAppServerRuntime({
      executablePath: config.executablePath,
      codexHome: isolated.codexHome,
      workingDirectory: request.workspace,
      environment: isolated.environment,
      spawnProcess,
      observeExecutable: async () => currentQualification.observation,
      beforeRun: async () => {
        const latest = await qualify();
        if (latest.fingerprint !== currentQualification.fingerprint) {
          throw new AppServerCompatibilityError({ stage: "qualification", reason: "runtime_changed_during_setup" });
        }
      },
      baseline: config.baseline,
      clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
      loadSchemaQualification: async (observation) => {
        await fsApi.mkdirPath(schemaDirectory, { recursive: true });
        await generateStableSchemaBundle({ executablePath: observation.executablePath, outputDirectory: schemaDirectory, spawnProcess });
        return readGeneratedSchemas(schemaDirectory, {
          readSchemaFile: fsApi.readFile,
        });
      },
      model: request.model,
      sanitizeForDisplay: redactor.sanitizeForDisplay,
      sanitizeCommandActions: (value) => redactor.redactJson(value),
    });
  };

  const core = createGeminiCompanionCore({
    validateRequest: async (request) => {
      const validated = await validateGeminiRequest(request, {
      permittedWorkspaceRoots: config.permittedWorkspaceRoots,
      defaultModel: config.fixedModel,
      allowedModels: config.allowedModels,
      realpathPath: fsApi.realpathPath,
      statPath: fsApi.statPath,
      });
      return { ...validated };
    },
    prepareRuntime,
    workspaceLeases: createWorkspaceLeaseManager(),
    workspaceManager,
    redactor,
    persistStatus: stateStore.persist,
    initialStatuses: recovered.filter((record) => ["completed", "failed", "cancelled"].includes(record.status)),
  });
  const localJobs = new Set();
  return Object.freeze({
    modelPolicy: Object.freeze({ defaultModel: config.fixedModel, allowedModels: config.allowedModels }),
    async runGeminiTask(request, hooks = {}) {
      const owner = await executionOwner.acquire();
      let cleanupConfirmed = true;
      let context;
      let validated;
      try {
        cleanupConfirmed = false;
        return await core.runGeminiTask(request, {
          ...hooks,
          onStarted: async (jobId) => { localJobs.add(jobId); await hooks.onStarted?.(jobId); },
          onWorkspacePrepared: async (workspace, value) => { context = workspace; validated = value; },
          onResult: async (result) => {
            if (result.sessionId) await sessions.save(result.sessionId, validated, currentQualification.fingerprint, context);
          },
          onCleanup: async (confirmed) => { cleanupConfirmed = confirmed; },
        });
      } finally {
        currentQualification = null;
        if (!cleanupConfirmed) await owner.quarantine();
        await owner.release();
      }
    },
    getGeminiStatus: (jobId) => localJobs.has(jobId) ? core.getGeminiStatus(jobId) : stateStore.read(jobId),
    async cancelGeminiTask(jobId) {
      if (localJobs.has(jobId)) return core.cancelGeminiTask(jobId);
      const status = await stateStore.read(jobId);
      if (["completed", "failed", "cancelled"].includes(status.status)) return status;
      throw Object.assign(new Error("Job belongs to another instance; stop it through its owner"), { code: "workspace_locked" });
    },
  });
}
