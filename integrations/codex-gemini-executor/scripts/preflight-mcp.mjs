#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseMcpConfig } from "./mcp-config.mjs";
import { ensureTestScratchRoot } from "../test/scratch-root.js";
import { createScopedIdentity, requireScopedQualification, sourceDigest } from "../src/scoped-qualification.js";
import { verifyRelease } from "../src/release.js";
import { validateConfiguredRouterUrl } from "../src/router-transport.js";

export { parseMcpConfig };
export const CANONICAL_MODEL = "ag/gemini-3.8-flash";
export const DEFAULT_CONFIG_PATH = "C:\\Users\\Admin\\.codex\\config.toml";
const PRIORITY = ["config_invalid", "qualification_record_missing", "router_identity_mismatch",
  "qualification_stale", "credential_presence_missing", "scratch_root_unwritable"];
const absolute = (s) => typeof s === "string" && /^[A-Za-z]:[\\/]/.test(s);
const normalize = (s) => absolute(s) ? win32.normalize(s).replace(/[\\/]+$/, "").toLowerCase() : null;
const samePath = (a, b) => normalize(a) !== null && normalize(a) === normalize(b);
const hash = (b) => createHash("sha256").update(b).digest("hex");

export function evaluatePreflight({
  config, qualification, manifest, observedIdentity, router, routerHealth = false,
  commandExists = false, entrypointExists = false, cwdExists = false, canonicalPaths = false,
  manifestVerified = false, apiKeyPresent = false, scratchWritable = false,
} = {}) {
  const failures = [];
  const checks = {};
  const c = config ?? {};
  const check = (name, passed, code) => {
    checks[name] = passed === true;
    if (!checks[name]) failures.push({ code, detail: name });
  };
  let endpointValid = false;
  try { validateConfiguredRouterUrl(c.routerBaseUrl); endpointValid = true; } catch { /* fail closed */ }
  check("endpoint", endpointValid, "config_invalid");
  check("fixedNode", samePath(c.command, process.execPath) && commandExists, "config_invalid");
  check("entrypoint", Array.isArray(c.args) && c.args.length === 1 && absolute(c.args[0])
    && samePath(c.args[0], win32.join(c.cwd ?? "", "src", "index.js")) && entrypointExists, "config_invalid");
  check("cwd", absolute(c.cwd) && cwdExists && canonicalPaths, "config_invalid");
  check("optionalEnabled", c.enabled === true && c.required === false, "config_invalid");
  check("environment", Array.isArray(c.envVars) && c.envVars.length === 1
    && c.envVars[0] === "NINEROUTER_API_KEY", "config_invalid");
  check("backend", c.backend === "router-responses-v1", "config_invalid");
  check("modelPolicy", c.model === CANONICAL_MODEL && c.models === CANONICAL_MODEL, "config_invalid");
  check("timeouts", Number.isInteger(c.startupTimeoutSec) && c.startupTimeoutSec >= 30
    && Number.isInteger(c.toolTimeoutSec) && c.toolTimeoutSec >= 2100, "config_invalid");
  check("workspaceRoots", typeof c.permittedWorkspaces === "string"
    && c.permittedWorkspaces.split(";").every((p) => absolute(p.trim())), "config_invalid");
  check("runtimeRoot", absolute(c.runtimeRoot), "config_invalid");
  check("apiKeyPresent", apiKeyPresent, "credential_presence_missing");
  check("scratchWritable", scratchWritable, "scratch_root_unwritable");
  check("routerHealth", routerHealth, "router_identity_mismatch");
  check("routerIdentity", router?.contractVersion === 1 && typeof router?.version === "string"
    && typeof router?.buildId === "string" && router.buildId.length > 0, "router_identity_mismatch");
  check("qualificationPresent", Boolean(qualification), "qualification_record_missing");
  if (qualification) {
    check("qualifiedRouter", isDeepStrictEqual(qualification.identity?.router, router), "router_identity_mismatch");
    let qualified = false;
    try { requireScopedQualification(observedIdentity, qualification); qualified = true; } catch { /* stale */ }
    check("qualifiedIdentityAndChecks", qualified, "qualification_stale");
  }
  check("releaseBytes", manifestVerified, "qualification_stale");
  check("releaseIdentity", Boolean(observedIdentity) && isDeepStrictEqual(manifest?.runtimeIdentity, observedIdentity),
    "qualification_stale");
  check("qualificationRelease", Boolean(manifest?.manifestSha256)
    && qualification?.release?.manifestSha256 === manifest?.manifestSha256
    && qualification?.release?.releaseId === manifest?.releaseId, "qualification_stale");
  const status = PRIORITY.find((code) => failures.some((f) => f.code === code)) ?? "pass";
  return {
    status, pass: status === "pass", readiness: "HOLD",
    scope: "preflight only; Desktop task acceptance is a separate gate",
    checks, router: router ?? null, runtimeFingerprint: checks.qualifiedIdentityAndChecks
      ? requireScopedQualification(observedIdentity, qualification) : null, failures,
  };
}

export async function fetchBoundedJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("http_status");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("body_missing");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error("body_limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function readJson(path, maximum = 1024 * 1024) {
  if ((await stat(path)).size > maximum) throw new Error("file_limit");
  return JSON.parse(await readFile(path, "utf8"));
}
async function exists(path, kind) {
  try { const s = await stat(path); return kind === "file" ? s.isFile() : s.isDirectory(); }
  catch { return false; }
}
export async function runPreflight({
  configPath = DEFAULT_CONFIG_PATH, qualificationPath,
  testScratchRoot = process.env.NINEROUTER_TEST_SCRATCH_ROOT,
  environment = process.env, fetchImpl = fetch,
} = {}) {
  let config;
  try {
    if ((await stat(configPath)).size > 1024 * 1024) throw new Error();
    config = parseMcpConfig(await readFile(configPath, "utf8"));
  } catch {
    return { status: "config_invalid", pass: false, readiness: "HOLD",
      failures: [{ code: "config_invalid", detail: "config_parse" }] };
  }
  const expectedQualification = win32.join(config.runtimeRoot ?? "", "qualified-scoped-combination.json");
  if (qualificationPath && !samePath(qualificationPath, expectedQualification)) {
    return { status: "config_invalid", pass: false, readiness: "HOLD",
      failures: [{ code: "config_invalid", detail: "qualification_path_does_not_match_runtime" }] };
  }
  const recordPath = qualificationPath ?? expectedQualification;
  const qualification = await readJson(recordPath, 16384).catch(() => null);
  const entrypoint = config.args?.[0];
  const commandExists = await exists(config.command, "file");
  const entrypointExists = await exists(entrypoint, "file");
  const cwdExists = await exists(config.cwd, "directory");
  let canonicalPaths = false;
  let observedIdentity;
  let manifest;
  let manifestVerified = false;
  let router;
  let routerHealth = false;
  try {
    const base = validateConfiguredRouterUrl(config.routerBaseUrl);
    const health = await fetchBoundedJson(base + "/api/health", fetchImpl);
    routerHealth = health.ok === true;
    const identity = await fetchBoundedJson(base + "/api/compatibility", fetchImpl);
    if (identity.contractVersion !== 1 || !/^[A-Za-z0-9._-]{1,128}$/.test(identity.version)
      || !/^[A-Za-z0-9._-]{1,256}$/.test(identity.buildId)) throw new Error();
    router = { version: identity.version, buildId: identity.buildId, contractVersion: 1 };
  } catch { /* no retry or alternate endpoint */ }
  try {
    canonicalPaths = samePath(await realpath(config.cwd), config.cwd)
      && samePath(await realpath(entrypoint), entrypoint)
      && samePath(await realpath(config.command), config.command);
    const sourceDirectory = win32.join(config.cwd, "src");
    const lockPath = win32.join(config.cwd, "package-lock.json");
    observedIdentity = createScopedIdentity({
      sourceDirectory, companionSha256: await sourceDigest(sourceDirectory),
      dependencyLockSha256: hash(await readFile(lockPath)),
      router, model: config.model, allowedModels: config.models.split(";"),
      routerBaseUrl: config.routerBaseUrl,
    });
    // New candidates keep the verified manifest adjacent to package.json.
    // Legacy parent manifests are diagnostic only and cannot pass verification.
    manifest = await readJson(win32.join(config.cwd, "release-manifest.json")).catch(() => null);
    if (!manifest) manifest = await readJson(win32.join(config.cwd, "..", "manifest.json")).catch(() => null);
    await verifyRelease(manifest, { sourceDirectory, lockPath });
    manifestVerified = true;
  } catch { /* stale or unavailable files */ }
  let scratchWritable = false;
  try {
    await ensureTestScratchRoot({ root: testScratchRoot, prefix: ".mcp-preflight-" });
    scratchWritable = true;
  } catch { /* explicit failure; no fallback */ }
  return { ...evaluatePreflight({
    config, qualification, manifest, observedIdentity, router, routerHealth,
    commandExists, entrypointExists, cwdExists, canonicalPaths, manifestVerified,
    apiKeyPresent: Boolean(environment.NINEROUTER_API_KEY), scratchWritable,
  }), configPath, qualificationPath: recordPath };
}
export async function main(args = process.argv.slice(2)) {
  const options = {};
  const names = { config: "configPath", qualification: "qualificationPath", scratch: "testScratchRoot" };
  for (const arg of args) {
    const match = arg.match(/^--(config|qualification|scratch)=(.+)$/);
    if (!match || Object.hasOwn(options, names[match[1]])) throw new Error("arguments_invalid");
    options[names[match[1]]] = match[2];
  }
  const result = await runPreflight(options);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.pass ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write('{"status":"config_invalid","pass":false,"readiness":"HOLD","failures":[{"code":"config_invalid","detail":"preflight_failed"}]}\n');
    process.exitCode = 1;
  });
}
