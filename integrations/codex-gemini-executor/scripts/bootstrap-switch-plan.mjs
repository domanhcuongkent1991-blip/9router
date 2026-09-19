#!/usr/bin/env node
// Verifies a candidate and writes a private proposal; never applies active config.
import { createHash } from "node:crypto";
import { readFile, writeFile, stat, realpath, readdir } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { win32 } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseMcpConfig } from "./mcp-config.mjs";
import { fetchBoundedJson } from "./preflight-mcp.mjs";
import { verifyRelease } from "../src/release.js";
import { createScopedIdentity, requireScopedBootstrap, SCOPED_BOOTSTRAP_PROFILE,
  sourceDigest, readScopedRouterIdentity } from "../src/scoped-qualification.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const execFile = promisify(execFileCallback);
export const APP_SERVER = "C:\\Users\\Admin\\.codex\\plugins\\.plugin-appserver\\codex.exe";
const normalized = (path) => win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase();
const samePath = (a, b) => typeof a === "string" && typeof b === "string" && normalized(a) === normalized(b);
function requireFact(fact, code) { if (!fact) throw new Error(code); }
async function json(path, limit = 1024 * 1024) {
  requireFact((await stat(path)).size <= limit, "candidate_metadata_too_large");
  return JSON.parse(await readFile(path, "utf8"));
}
async function absent(path) {
  try { await stat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
export function renderBootstrapConfig(original, candidate) {
  const config = parseMcpConfig(original);
  requireFact(config.model === candidate.model && config.models === candidate.model
    && config.backend === "router-responses-v1" && config.routerBaseUrl === candidate.routerBaseUrl,
  "current_routing_differs");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const quote = JSON.stringify;
  const base = [
    "[mcp_servers.nine-router-gemini]",
    "command = " + quote(candidate.nodePath),
    "args = [" + quote(win32.join(candidate.packageDirectory, "src", "index.js")) + "]",
    "cwd = " + quote(candidate.packageDirectory),
    "enabled = true", "required = false", "startup_timeout_sec = 30", "tool_timeout_sec = 7500",
    'env_vars = ["NINEROUTER_API_KEY"]', "",
  ].join(eol);
  const env = [
    "[mcp_servers.nine-router-gemini.env]",
    'NINEROUTER_EXECUTION_BACKEND = "router-responses-v1"',
    "NINEROUTER_GEMINI_MODEL = " + quote(candidate.model),
    "NINEROUTER_GEMINI_MODELS = " + quote(candidate.model),
    "NINEROUTER_ROUTER_BASE_URL = " + quote(candidate.routerBaseUrl),
    "NINEROUTER_PERMITTED_WORKSPACES = " + quote(SCOPED_BOOTSTRAP_PROFILE.workspace),
    "NINEROUTER_RUNTIME_ROOT = " + quote(candidate.runtimeRoot),
    "NINEROUTER_WORKTREE_ROOT = " + quote(candidate.worktreeRoot), "",
  ].join(eol);
  let updated = original;
  const entries = [
    ["mcp_servers.nine-router-gemini", base,
      ["command", "args", "cwd", "enabled", "required", "startup_timeout_sec", "tool_timeout_sec", "env_vars"]],
    ["mcp_servers.nine-router-gemini.env", env,
      ["NINEROUTER_EXECUTION_BACKEND", "NINEROUTER_GEMINI_MODEL", "NINEROUTER_GEMINI_MODELS",
        "NINEROUTER_ROUTER_BASE_URL", "NINEROUTER_PERMITTED_WORKSPACES", "NINEROUTER_RUNTIME_ROOT", "NINEROUTER_WORKTREE_ROOT"]],
  ];
  for (const [name, replacement, allowed] of entries) {
    const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("^\\[" + escaped + "\\][ \\t]*\\r?\\n[\\s\\S]*?(?=^[ \\t]*\\[|(?![\\s\\S]))", "gm");
    const matches = [...updated.matchAll(pattern)];
    requireFact(matches.length === 1, "target_section_ambiguous");
    const span = matches[0];
    for (const key of span[0].matchAll(/^[ \t]*([A-Za-z0-9_-]+)[ \t]*=/gm)) {
      requireFact(allowed.includes(key[1]), "unsupported_target_setting");
    }
    updated = updated.slice(0, span.index) + replacement + eol + updated.slice(span.index + span[0].length);
  }
  parseMcpConfig(updated);
  return updated;
}
export async function inspectBootstrapCandidate(directory) {
  requireFact(/^[A-Za-z]:[\\/]/.test(directory) && samePath(await realpath(directory), directory), "candidate_path_invalid");
  const descriptor = await json(win32.join(directory, "candidate.json"));
  const pkg = win32.join(directory, "package");
  const runtimeRoot = win32.join(directory, "bootstrap-runtime");
  requireFact(samePath(descriptor.directory, directory) && samePath(descriptor.packageDirectory, pkg), "candidate_layout_mismatch");
  requireFact(samePath(await realpath(pkg), pkg), "candidate_alias_rejected");
  const sourceDirectory = win32.join(pkg, "src");
  const manifestPath = win32.join(pkg, "release-manifest.json");
  const lockPath = win32.join(pkg, "package-lock.json");
  const manifest = await json(manifestPath);
  await verifyRelease(manifest, { sourceDirectory, lockPath });
  const identity = createScopedIdentity({
    sourceDirectory, companionSha256: await sourceDigest(sourceDirectory),
    dependencyLockSha256: hash(await readFile(lockPath)),
    router: await readScopedRouterIdentity({ baseUrl: descriptor.identity.routerBaseUrl }),
    routerBaseUrl: descriptor.identity.routerBaseUrl, model: descriptor.identity.model,
    allowedModels: descriptor.identity.allowedModels,
  });
  requireFact(identity.model === "ag/gemini-3.8-flash" && isDeepStrictEqual(identity.allowedModels, [identity.model]),
    "candidate_model_policy_invalid");
  requireFact(isDeepStrictEqual(identity, descriptor.identity) && isDeepStrictEqual(identity, manifest.runtimeIdentity),
    "candidate_identity_changed");
  requireFact(descriptor.release.releaseId === manifest.releaseId
    && descriptor.release.manifestSha256 === manifest.manifestSha256, "candidate_release_changed");
  requireFact(await sourceDigest(win32.join(pkg, "node_modules")) === descriptor.dependenciesSha256, "candidate_dependencies_changed");
  for (const file of [manifestPath, win32.join(pkg, "src", "index.js")]) {
    requireFact(((await stat(file)).mode & 0o222) === 0, "candidate_not_readonly");
  }
  requireFact(await absent(win32.join(runtimeRoot, "execution-owner.json")), "candidate_runtime_busy");
  requireFact(await absent(win32.join(runtimeRoot, "qualified-scoped-combination.json")), "bootstrap_only_required");
  const record = await json(win32.join(runtimeRoot, "qualified-scoped-bootstrap.json"), 16384);
  const fingerprint = requireScopedBootstrap(identity, record);
  const live = await json(win32.join(directory, "live-canary-report.json"));
  const stdio = await json(win32.join(directory, "bootstrap-stdio-report.json"));
  requireFact(live.status === "pass" && stdio.status === "pass"
    && isDeepStrictEqual(live.identity, identity) && isDeepStrictEqual(live.release, descriptor.release)
    && isDeepStrictEqual(stdio.release, descriptor.release)
    && stdio.bootstrap.fingerprint === fingerprint, "candidate_evidence_mismatch");
  for (const k of ["initialize", "toolsList", "fixedReadOnly", "status", "cancelTerminalIdempotent", "statusAfterRestart", "ownerReleased"]) {
    requireFact(stdio.checks[k] === true, "candidate_stdio_incomplete");
  }
  requireFact(samePath(identity.node.path, process.execPath), "node_identity_changed");
  requireFact((await fetchBoundedJson(identity.routerBaseUrl + "/api/health")).ok === true, "router_unhealthy");
  return {
    candidatePath: directory, packageDirectory: pkg, runtimeRoot,
    worktreeRoot: win32.join(directory, "bootstrap-worktrees"),
    nodePath: identity.node.path, model: identity.model, routerBaseUrl: identity.routerBaseUrl,
    releaseId: manifest.releaseId, manifestSha256: manifest.manifestSha256,
    bootstrapFingerprint: fingerprint, permittedWorkspace: SCOPED_BOOTSTRAP_PROFILE.workspace,
    scope: "fixed read-only bootstrap only", readiness: "HOLD",
  };
}
export async function assertRuntimeIdle(runtimeRoot) {
  requireFact(await absent(win32.join(runtimeRoot, "execution-owner.json")), "runtime_owner_present");
  const jobDirectory = win32.join(runtimeRoot, "jobs");
  if (await absent(jobDirectory)) return;
  const names = await readdir(jobDirectory);
  requireFact(names.length <= 10000, "runtime_jobs_unbounded");
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const record = await json(win32.join(jobDirectory, name), 65536);
    requireFact(["completed", "failed", "cancelled"].includes(record.status), "runtime_job_nonterminal");
    requireFact(record.recoveryRequired !== true, "runtime_recovery_pending");
  }
}
export async function assertPreviousRuntimeSafe(runtimeRoot, { bootedAt } = {}) {
  requireFact(await absent(win32.join(runtimeRoot, "execution-owner.json")), "runtime_owner_present");
  const jobDirectory = win32.join(runtimeRoot, "jobs");
  if (await absent(jobDirectory)) return { staleJobs: 0 };
  const names = await readdir(jobDirectory);
  requireFact(names.length <= 10000, "runtime_jobs_unbounded");
  let staleJobs = 0;
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const record = await json(win32.join(jobDirectory, name), 65536);
    requireFact(record.recoveryRequired !== true, "runtime_recovery_pending");
    if (["completed", "failed", "cancelled"].includes(record.status)) continue;
    // Only a fixed read-only fixture job that predates this Windows boot can be
    // retained as historical. The PS transaction separately proves no executor
    // process exists; arbitrary running/write/recovery jobs still block switching.
    requireFact(["starting", "running", "awaiting_approval"].includes(record.status)
      && samePath(record.workspace, SCOPED_BOOTSTRAP_PROFILE.workspace)
      && record.worktreePath === null
      && Number.isFinite(Date.parse(bootedAt)) && Date.parse(bootedAt) <= Date.now()
      && Date.parse(record.updatedAt) < Date.parse(bootedAt), "runtime_job_nonterminal");
    staleJobs += 1;
  }
  return { staleJobs };
}
export function assertAuthorityConfig(actual, candidate) {
  requireFact(actual?.name === "nine-router-gemini" && actual.enabled === true
    && actual.disabled_reason == null && actual.startup_timeout_sec === 30
    && actual.tool_timeout_sec === 7500 && actual.enabled_tools == null && actual.disabled_tools == null,
  "app_server_settings_mismatch");
  requireFact(isDeepStrictEqual(actual.transport, {
    type: "stdio", command: candidate.nodePath,
    args: [win32.join(candidate.packageDirectory, "src", "index.js")],
    cwd: candidate.packageDirectory, env_vars: ["NINEROUTER_API_KEY"],
    env: {
      NINEROUTER_EXECUTION_BACKEND: "router-responses-v1",
      NINEROUTER_GEMINI_MODEL: candidate.model, NINEROUTER_GEMINI_MODELS: candidate.model,
      NINEROUTER_ROUTER_BASE_URL: candidate.routerBaseUrl,
      NINEROUTER_PERMITTED_WORKSPACES: SCOPED_BOOTSTRAP_PROFILE.workspace,
      NINEROUTER_RUNTIME_ROOT: candidate.runtimeRoot,
      NINEROUTER_WORKTREE_ROOT: candidate.worktreeRoot,
    },
  }), "app_server_transport_mismatch");
}
async function authorityIdentity() {
  const before = hash(await readFile(APP_SERVER));
  const { stdout } = await execFile(APP_SERVER, ["--version"], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
  requireFact(before === hash(await readFile(APP_SERVER)) && /^codex-cli [A-Za-z0-9.+-]+$/.test(stdout.trim()),
    "app_server_identity_changed");
  return { path: APP_SERVER, sha256: before, version: stdout.trim() };
}
export async function validateAuthority(configPath, plan) {
  requireFact(win32.basename(configPath) === "config.toml", "authority_config_name_invalid");
  requireFact(hash(await readFile(configPath)) === plan.afterSha256, "proposal_changed");
  requireFact(isDeepStrictEqual(await authorityIdentity(), plan.appServer), "app_server_identity_changed");
  const { stdout } = await execFile(APP_SERVER, ["mcp", "get", "nine-router-gemini", "--json"], {
    cwd: win32.dirname(configPath), env: { ...process.env, CODEX_HOME: win32.dirname(configPath) },
    timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assertAuthorityConfig(JSON.parse(stdout), plan);
  requireFact(hash(await readFile(configPath)) === plan.afterSha256, "config_changed_during_validation");
  requireFact(isDeepStrictEqual(await authorityIdentity(), plan.appServer), "app_server_identity_changed");
  return { status: "pass", appServer: plan.appServer };
}
export async function prepareBootstrapPlan(directory, configPath, proposalPath) {
  const candidate = await inspectBootstrapCandidate(directory);
  requireFact((await stat(configPath)).size <= 1024 * 1024, "config_too_large");
  const before = await readFile(configPath);
  const updated = renderBootstrapConfig(before.toString("utf8"), candidate);
  await writeFile(proposalPath, updated, { flag: "wx", mode: 0o600 });
  return { ...candidate, configPath, proposalPath, previousRuntimeRoot: parseMcpConfig(before.toString("utf8")).runtimeRoot,
    appServer: await authorityIdentity(), credentialPresent: Boolean(process.env.NINEROUTER_API_KEY),
    beforeSha256: hash(before), afterSha256: hash(updated) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let result;
    if (process.argv[2] === "--validate") {
      result = await validateAuthority(process.argv[3], await json(process.argv[4]));
    } else if (process.argv[2] === "--verify-idle") {
      const plan = await json(process.argv[3]);
      const fresh = await inspectBootstrapCandidate(plan.candidatePath);
      requireFact(Object.keys(fresh).every((key) => isDeepStrictEqual(fresh[key], plan[key])), "candidate_plan_changed");
      requireFact(isDeepStrictEqual(await authorityIdentity(), plan.appServer), "app_server_identity_changed");
      const previous = await assertPreviousRuntimeSafe(plan.previousRuntimeRoot, { bootedAt: process.argv[4] });
      await assertRuntimeIdle(plan.runtimeRoot);
      result = { status: "pass", previousRuntime: previous };
    } else {
      result = await prepareBootstrapPlan(process.argv[2], process.argv[3], process.argv[4]);
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const code = /^[a-z_]{3,80}$/.test(error.message) ? error.message : "bootstrap_verification_failed";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  }
}
