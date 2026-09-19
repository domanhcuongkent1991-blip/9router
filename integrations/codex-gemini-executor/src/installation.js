import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { createGeminiCompanionCore } from "./core.js";
import { createCompanionRedactor } from "./redaction.js";
import { isSafeModelIdentifier, validateGeminiRequest } from "./request.js";
import { createJobStateStore } from "./state-store.js";
import { createWorkspaceLeaseManager } from "./workspace-lease.js";
import { createExecutionOwner } from "./execution-owner.js";
import {
  createScopedIdentity,
  matchesScopedBootstrapRequest,
  readScopedRouterIdentity,
  requireScopedBootstrap,
  requireScopedQualification,
  ScopedQualificationError,
  sourceDigest,
} from "./scoped-qualification.js";
import { createFileBroker, summarizeRecoveryJournal } from "./file-broker.js";
import { createRouterResponsesRuntime, validateRouterBaseUrl } from "./router-responses-runtime.js";

const RUNTIME_ROOT = "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime";
const WORKTREE_ROOT = "C:\\tmp\\CodexScratch\\9router-gemini-jobs";
const APP_SERVER_SCHEMA_BUNDLE = "codex_app_server_protocol.schemas.json";
const MAX_GENERATED_SCHEMA_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const execFile = promisify(execFileCallback);

export async function observeInstalledCombination(config, dependencies = {}) {
  const [{ observeConfiguredExecutable }, { readExecutableVersion }, { readRouterIdentity }] = await Promise.all([
    import("./app-server/executable.js"),
    import("./app-server/process.js"),
    import("./qualification.js"),
  ]);
  const read = dependencies.read ?? readFile;
  const observe = dependencies.observe ?? observeConfiguredExecutable;
  const routerIdentity = dependencies.routerIdentity ?? readRouterIdentity;
  const digestSource = dependencies.digestSource ?? sourceDigest;
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
  const configuredBackend = environment.NINEROUTER_EXECUTION_BACKEND;
  const executionBackend = configuredBackend === undefined ? "legacy-app-server" : required(environment, "NINEROUTER_EXECUTION_BACKEND", 128);
  if (!["legacy-app-server", "router-responses-v1"].includes(executionBackend)) {
    throw new InstallationConfigError("unsupported_execution_backend");
  }
  const runtimeRoot = storageRoot(environment, "NINEROUTER_RUNTIME_ROOT", RUNTIME_ROOT);
  const worktreeRoot = storageRoot(environment, "NINEROUTER_WORKTREE_ROOT", WORKTREE_ROOT);
  const runtimeKey = runtimeRoot.toLowerCase();
  const worktreeKey = worktreeRoot.toLowerCase();
  if (runtimeKey === worktreeKey || runtimeKey.startsWith(`${worktreeKey}\\`)
    || worktreeKey.startsWith(`${runtimeKey}\\`)) throw new InstallationConfigError("overlapping_storage_roots");
  const fixedModel = required(environment, "NINEROUTER_GEMINI_MODEL", 256);
  const allowedModels = modelAllowlist(environment, fixedModel);
  const apiKey = required(environment, "NINEROUTER_API_KEY", 16 * 1024);
  const roots = required(environment, "NINEROUTER_PERMITTED_WORKSPACES", 32 * 1024)
    .split(";").map((value) => value.trim()).filter(Boolean);
  let executablePath;
  let allowedExecutableRoot;
  let baseline;
  if (executionBackend === "legacy-app-server") {
    executablePath = required(environment, "NINEROUTER_CODEX_APP_SERVER_PATH");
    allowedExecutableRoot = required(environment, "NINEROUTER_CODEX_APP_SERVER_ROOT");
    const version = required(environment, "NINEROUTER_CODEX_BASELINE_VERSION", 4096);
    const executableSha256 = required(environment, "NINEROUTER_CODEX_BASELINE_SHA256", 64).toLowerCase();
    if (!win32.isAbsolute(executablePath) || !win32.isAbsolute(allowedExecutableRoot) || !SHA256.test(executableSha256)) {
      throw new InstallationConfigError("invalid_value");
    }
    baseline = Object.freeze({ version, executableSha256 });
  }
  if (!isSafeModelIdentifier(fixedModel)
    || roots.length === 0 || roots.length > 64 || roots.some((root) => !win32.isAbsolute(root))) {
    throw new InstallationConfigError("invalid_value");
  }
  let routerBaseUrl;
  if (executionBackend === "router-responses-v1") {
    let endpoint;
    try { endpoint = validateRouterBaseUrl(environment.NINEROUTER_ROUTER_BASE_URL ?? "http://127.0.0.1:20128"); }
    catch { throw new InstallationConfigError("invalid_router_base_url"); }
    routerBaseUrl = endpoint.slice(0, -"/v1/responses".length);
  }
  return Object.freeze({ executionBackend, executablePath, allowedExecutableRoot, fixedModel, allowedModels, apiKey, runtimeRoot, worktreeRoot,
    routerBaseUrl, permittedWorkspaceRoots: roots, baseline });
}

function childEnvironment(environment, apiKey) {
  const output = { NINEROUTER_API_KEY: apiKey };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT"]) {
    if (typeof environment[key] === "string") output[key] = environment[key];
  }
  return output;
}

export async function readGeneratedSchemas(directory, { readSchemaFile = readFile } = {}) {
  const { combineSchemaQualifications, qualifyApprovalSchemaBundle, qualifyStableSchemaBundle } =
    await import("./app-server/schema-qualification.js");
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

async function createScopedResponsesCompanion({ config, environment, dependencies, requireQualification = true }) {
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
  const stateStore = createJobStateStore({ stateRoot: win32.join(config.runtimeRoot, "jobs"), ...fsApi });
  const recovered = await stateStore.reconcile();
  const redactor = createCompanionRedactor({ knownSecrets: [config.apiKey] });
  const executionOwner = dependencies.executionOwner ?? createExecutionOwner({ directory: config.runtimeRoot });
  const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
  const scopedJournalDirectory = win32.join(config.runtimeRoot, "scoped-jobs");
  const protectedRoots = [config.runtimeRoot, scopedJournalDirectory, sourceDirectory, dirname(process.execPath)];
  const installationPolicy = {
    permittedWorkspaceRoots: config.permittedWorkspaceRoots,
    protectedRoots,
    runtimeRoot: config.runtimeRoot,
    backupRoot: scopedJournalDirectory,
    sourceDirectory,
    nodeRuntimeRoot: dirname(process.execPath),
    runtimeFingerprint: "router-responses-v1",
    runtimeModel: config.fixedModel,
    requireFixedModel: true,
    requireScopedProfile: true,
  };
  const createBroker = dependencies.fileBrokerFactory ?? createFileBroker;
  const createRuntime = dependencies.responsesRuntimeFactory ?? createRouterResponsesRuntime;
  async function qualifyScoped(request) {
    const routerIdentity = dependencies.routerIdentity
      ? await dependencies.routerIdentity({ baseUrl: config.routerBaseUrl })
      : await readScopedRouterIdentity({ baseUrl: config.routerBaseUrl, fetchJson: dependencies.fetchImpl ?? fetch });
    const identity = createScopedIdentity({
      companionSha256: await (dependencies.digestSource ?? sourceDigest)(sourceDirectory),
      dependencyLockSha256: createHash("sha256").update(await fsApi.readFile(
        win32.join(sourceDirectory, "..", "package-lock.json"), "utf8",
      )).digest("hex"),
      router: routerIdentity,
      model: config.fixedModel,
    });
    if (!requireQualification) return { identity, fingerprint: "unqualified-canary" };
    let approval;
    try {
      const text = await fsApi.readFile(win32.join(config.runtimeRoot, "qualified-scoped-combination.json"), "utf8");
      if (Buffer.byteLength(text, "utf8") > 16_384) throw new Error();
      approval = JSON.parse(text);
      return { identity, fingerprint: requireScopedQualification(identity, approval) };
    } catch (error) {
      if (error instanceof ScopedQualificationError && error.details?.reason !== "scoped_combination_not_qualified") throw error;
    }
    try {
      const text = await fsApi.readFile(win32.join(config.runtimeRoot, "qualified-scoped-bootstrap.json"), "utf8");
      if (Buffer.byteLength(text, "utf8") > 16_384) throw new Error();
      approval = JSON.parse(text);
      requireScopedBootstrap(identity, approval);
      if (!matchesScopedBootstrapRequest(request)) throw new ScopedQualificationError("scoped_bootstrap_request_denied");
      return { identity, fingerprint: `bootstrap:${requireScopedBootstrap(identity, approval)}` };
    } catch (error) {
      if (error instanceof ScopedQualificationError) throw error;
      throw new ScopedQualificationError("scoped_qualification_record_missing");
    }
  }
  const core = createGeminiCompanionCore({
    validateRequest: async (request) => {
      const validated = await validateGeminiRequest(request, {
        permittedWorkspaceRoots: config.permittedWorkspaceRoots,
        installationPolicy,
        defaultModel: config.fixedModel,
        allowedModels: config.allowedModels,
        realpathPath: fsApi.realpathPath,
        statPath: fsApi.statPath,
        lstatPath: fsApi.lstatPath,
      });
      return { ...validated };
    },
    prepareRuntime: async ({ grant, request, signal }) => {
      if (!grant) throw Object.assign(new Error("Scoped grant required"), { code: "runtime_not_supported" });
      const qualification = await qualifyScoped(request);
      if (grant.runtimeFingerprint !== qualification.fingerprint) {
        throw Object.assign(new Error("Scoped runtime identity changed"), { code: "runtime_not_supported" });
      }
      const broker = createBroker({
        grant,
        journalDirectory: scopedJournalDirectory,
        signal,
        fs: {
          appendFilePath: dependencies.appendFilePath,
          lstatPath: fsApi.lstatPath,
          mkdirPath: fsApi.mkdirPath,
          openPath: dependencies.openPath,
          readFilePath: fsApi.readFile,
          readdirPath: fsApi.listDirectory,
          realpathPath: fsApi.realpathPath,
          writeFilePath: fsApi.writeFile,
        },
      });
      return createRuntime({
        baseUrl: config.routerBaseUrl,
        apiKey: config.apiKey,
        model: config.fixedModel,
        effort: request.effort,
        broker,
        fetchImpl: dependencies.fetchImpl ?? fetch,
        signal,
      });
    },
    resolveScopedRuntimeFingerprint: async ({ request }) => (await qualifyScoped(request)).fingerprint,
    workspaceLeases: createWorkspaceLeaseManager(),
    redactor,
    persistStatus: stateStore.persist,
    initialStatuses: recovered.filter((record) => ["completed", "failed", "cancelled"].includes(record.status)),
  });
  const localJobs = new Set();
  async function mergeScopedRecoveryStatus(status, jobId) {
    const journal = await summarizeRecoveryJournal({
      journalDirectory: scopedJournalDirectory,
      jobId,
      fs: { readFilePath: fsApi.readFile },
    });
    const filesChanged = [...new Set([...(status.filesChanged ?? []), ...(journal.filesChanged ?? [])])]
      .sort((left, right) => left.localeCompare(right, "en"));
    const {
      recoveryRequired: persistedRecoveryRequired,
      recoveryId: persistedRecoveryId,
      recoverySources: persistedRecoverySources,
      recoveryOperationIds: persistedRecoveryOperationIds,
      ...baseStatus
    } = status;
    const knownSources = ["journal", "cleanup", "unknown"];
    const recoverySources = new Set(Array.isArray(persistedRecoverySources)
      && persistedRecoverySources.length > 0
      && persistedRecoverySources.every((source) => knownSources.includes(source))
      ? persistedRecoverySources
      : (persistedRecoveryRequired === true ? ["unknown"] : []));
    let recoveryOperationIds = Array.isArray(persistedRecoveryOperationIds)
      && persistedRecoveryOperationIds.length <= 16
      && persistedRecoveryOperationIds.every((opId) => typeof opId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(opId))
      ? persistedRecoveryOperationIds : [];
    let recoveryId = typeof persistedRecoveryId === "string" ? persistedRecoveryId : undefined;
    if (journal.recoveryRequired) {
      recoverySources.add("journal");
      recoveryId = typeof journal.recoveryId === "string" ? journal.recoveryId : `recovery_${jobId}`;
    // A readable applied record is not evidence that a failed fsync was resolved.
    // Only matching restore evidence clears journal recovery; cleanup stays separate.
    } else if (journal.journalVerified && recoverySources.has("journal")
      && recoveryOperationIds.length > 0
      && recoveryOperationIds.every((opId) => journal.resolvedOperationIds?.includes(opId))) {
      recoverySources.delete("journal");
      recoveryOperationIds = [];
    }
    const recoveryRequired = recoverySources.size > 0;
    if (!recoveryRequired) recoveryId = undefined;
    return {
      ...baseStatus,
      ...(filesChanged.length > 0 ? { filesChanged } : {}),
      ...(recoveryRequired ? { recoveryRequired: true } : {}),
      ...(recoveryId ? { recoveryId } : {}),
      ...(recoverySources.size > 0 ? { recoverySources: [...recoverySources].sort() } : {}),
      ...(recoveryOperationIds.length > 0 ? { recoveryOperationIds } : {}),
    };
  }
  async function readScopedStatus(jobId) {
    return mergeScopedRecoveryStatus(await stateStore.read(jobId), jobId);
  }
  return Object.freeze({
    modelPolicy: Object.freeze({ defaultModel: config.fixedModel, allowedModels: config.allowedModels }),
    async runGeminiTask(request, hooks = {}) {
      const owner = await executionOwner.acquire();
      let cleanupConfirmed = true;
      try {
        cleanupConfirmed = false;
        return await core.runGeminiTask(request, {
          ...hooks,
          onStarted: async (jobId) => { localJobs.add(jobId); await hooks.onStarted?.(jobId); },
          onCleanup: async (confirmed) => { cleanupConfirmed = confirmed; await hooks.onCleanup?.(confirmed); },
        });
      } finally {
        if (!cleanupConfirmed) await owner.quarantine();
        await owner.release();
      }
    },
    getGeminiStatus: (jobId) => localJobs.has(jobId)
      ? mergeScopedRecoveryStatus(core.getGeminiStatus(jobId), jobId)
      : readScopedStatus(jobId),
    async cancelGeminiTask(jobId) {
      if (localJobs.has(jobId)) return mergeScopedRecoveryStatus(await core.cancelGeminiTask(jobId), jobId);
      const status = await readScopedStatus(jobId);
      if (["completed", "failed", "cancelled"].includes(status.status)) return status;
      throw Object.assign(new Error("Job belongs to another instance; stop it through its owner"), { code: "workspace_locked" });
    },
  });
}

export async function createInstalledGeminiCompanion({ environment = process.env, dependencies = {} } = {}) {
  const config = readInstallationConfig(environment);
  if (config.executionBackend === "router-responses-v1") {
    return createScopedResponsesCompanion({ config, environment, dependencies });
  }
  const [
    { prepareAppServerRuntime },
    { observeConfiguredExecutable },
    { generateStableSchemaBundle, readExecutableVersion },
    { createChildHomeManager },
    { createWorkspaceManager },
    { createSessionStore },
    { requireQualifiedCombination, readRouterIdentity },
    { AppServerCompatibilityError },
  ] = await Promise.all([
    import("./app-server/runtime.js"),
    import("./app-server/executable.js"),
    import("./app-server/process.js"),
    import("./child-home.js"),
    import("./workspace.js"),
    import("./session-store.js"),
    import("./qualification.js"),
    import("./app-server/compatibility.js"),
  ]);
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
  const childHome = createChildHomeManager({ runtimeRoot: config.runtimeRoot, ...fsApi, fixedModel: config.fixedModel });
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
    const approvalPolicy = request.access === "read-only" ? "never" : "on-request";
    const isolated = await childHome.prepare(childEnvironment(environment, config.apiKey), config.fixedModel, approvalPolicy);
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
      installationPolicy: { rejectScopedProfile: true },
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
    modelPolicy: Object.freeze({ defaultModel: config.fixedModel, allowedModels: config.allowedModels }),
    getGeminiStatus: (jobId) => localJobs.has(jobId) ? core.getGeminiStatus(jobId) : stateStore.read(jobId),
    async cancelGeminiTask(jobId) {
      if (localJobs.has(jobId)) return core.cancelGeminiTask(jobId);
      const status = await stateStore.read(jobId);
      if (["completed", "failed", "cancelled"].includes(status.status)) return status;
      throw Object.assign(new Error("Job belongs to another instance; stop it through its owner"), { code: "workspace_locked" });
    },
  });
}

export async function createScopedCanaryCompanion({ environment = process.env, dependencies = {} } = {}) {
  const config = readInstallationConfig(environment);
  if (config.executionBackend !== "router-responses-v1") {
    throw new InstallationConfigError("scoped_backend_required");
  }
  return createScopedResponsesCompanion({ config, environment, dependencies, requireQualification: false });
}
