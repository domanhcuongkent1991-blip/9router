import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";

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
import { validateGeminiRequest } from "./request.js";
import { createJobStateStore } from "./state-store.js";
import { createWorkspaceLeaseManager } from "./workspace-lease.js";
import { createWorkspaceManager } from "./workspace.js";

const RUNTIME_ROOT = "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime";
const WORKTREE_ROOT = "C:\\tmp\\CodexScratch\\9router-gemini-jobs";
const SHA256 = /^[a-f0-9]{64}$/u;
const execFile = promisify(execFileCallback);

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

export function readInstallationConfig(environment = process.env) {
  const executablePath = required(environment, "NINEROUTER_CODEX_APP_SERVER_PATH");
  const allowedExecutableRoot = required(environment, "NINEROUTER_CODEX_APP_SERVER_ROOT");
  const version = required(environment, "NINEROUTER_CODEX_BASELINE_VERSION", 4096);
  const executableSha256 = required(environment, "NINEROUTER_CODEX_BASELINE_SHA256", 64).toLowerCase();
  const fixedModel = required(environment, "NINEROUTER_GEMINI_MODEL", 256);
  const apiKey = required(environment, "NINEROUTER_API_KEY", 16 * 1024);
  const roots = required(environment, "NINEROUTER_PERMITTED_WORKSPACES", 32 * 1024)
    .split(";").map((value) => value.trim()).filter(Boolean);
  if (!win32.isAbsolute(executablePath) || !win32.isAbsolute(allowedExecutableRoot)
    || !SHA256.test(executableSha256) || !/^[A-Za-z0-9._:/-]{1,256}$/u.test(fixedModel)
    || roots.length === 0 || roots.length > 64 || roots.some((root) => !win32.isAbsolute(root))) {
    throw new InstallationConfigError("invalid_value");
  }
  return Object.freeze({ executablePath, allowedExecutableRoot, fixedModel, apiKey, permittedWorkspaceRoots: roots,
    baseline: Object.freeze({ version, executableSha256 }) });
}

function childEnvironment(environment, apiKey) {
  const output = { NINEROUTER_API_KEY: apiKey };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT"]) {
    if (typeof environment[key] === "string") output[key] = environment[key];
  }
  return output;
}

async function readGeneratedSchemas(directory, { readDirectory = readdir, readSchemaFile = readFile } = {}) {
  const entries = await readDirectory(directory, { withFileTypes: true, recursive: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (files.length === 0 || files.length > 64) throw new InstallationConfigError("invalid_generated_schema_set");
  let stable;
  let approvals;
  for (const entry of files) {
    const parent = entry.parentPath ?? entry.path ?? directory;
    const raw = await readSchemaFile(win32.join(parent, entry.name), "utf8");
    if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) throw new InstallationConfigError("generated_schema_too_large");
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new InstallationConfigError("invalid_generated_schema_json"); }
    if (parsed?.definitions?.ClientRequest) stable = parsed;
    if (parsed?.definitions?.ServerRequest) approvals = parsed;
  }
  if (!stable || !approvals) throw new InstallationConfigError("required_generated_schema_missing");
  return combineSchemaQualifications(
    qualifyStableSchemaBundle(stable),
    qualifyApprovalSchemaBundle(approvals),
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
  const stateStore = createJobStateStore({ stateRoot: win32.join(RUNTIME_ROOT, "jobs"), ...fsApi });
  const recovered = await stateStore.reconcile();
  const redactor = createCompanionRedactor({ knownSecrets: [config.apiKey] });
  const childHome = createChildHomeManager({ runtimeRoot: RUNTIME_ROOT, ...fsApi, fixedModel: config.fixedModel });
  const workspaceManager = createWorkspaceManager({ worktreeRoot: WORKTREE_ROOT, execFile: execFileSafe, ...fsApi });

  const prepareRuntime = async ({ jobId, request }) => {
    const isolated = await childHome.prepare(childEnvironment(environment, config.apiKey));
    const schemaDirectory = win32.join(WORKTREE_ROOT, `${jobId}-schema`);
    return prepareAppServerRuntime({
      executablePath: config.executablePath,
      codexHome: isolated.codexHome,
      workingDirectory: request.workspace,
      environment: isolated.environment,
      spawnProcess,
      observeExecutable: () => observeConfiguredExecutable({
        executablePath: config.executablePath,
        allowedExecutableRoot: config.allowedExecutableRoot,
        realpathPath: fsApi.realpathPath,
        statPath: fsApi.statPath,
        createInputStream: dependencies.createInputStream ?? createReadStream,
        readVersion: (path) => readExecutableVersion({ executablePath: path, spawnProcess }),
      }),
      baseline: config.baseline,
      clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
      loadSchemaQualification: async () => {
        await fsApi.mkdirPath(schemaDirectory, { recursive: true });
        await generateStableSchemaBundle({ executablePath: config.executablePath, outputDirectory: schemaDirectory, spawnProcess });
        return readGeneratedSchemas(schemaDirectory, {
          readDirectory: fsApi.listDirectory,
          readSchemaFile: fsApi.readFile,
        });
      },
      fixedModel: config.fixedModel,
      fixedModelProvider: "nine_router",
      sanitizeForDisplay: redactor.sanitizeForDisplay,
    });
  };

  return createGeminiCompanionCore({
    validateRequest: (request) => validateGeminiRequest(request, {
      permittedWorkspaceRoots: config.permittedWorkspaceRoots,
      realpathPath: fsApi.realpathPath,
      statPath: fsApi.statPath,
    }),
    prepareRuntime,
    workspaceLeases: createWorkspaceLeaseManager(),
    workspaceManager,
    redactor,
    persistStatus: stateStore.persist,
    initialStatuses: recovered,
  });
}
