import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { createHash } from "node:crypto";
import { evaluatePreflight, parseMcpConfig, fetchBoundedJson, runPreflight } from "../scripts/preflight-mcp.mjs";
import { createScopedIdentity, REQUIRED_SCOPED_CANARY_CHECKS, sourceDigest } from "../src/scoped-qualification.js";
import { buildRelease } from "../src/release.js";
import { createTestScratchDirectory } from "./scratch-root.js";

function toml(cwd = "C:\\release\\integrations", runtime = "C:\\candidate-runtime") {
  return [
    "[mcp_servers.nine-router-gemini]",
    "command = " + JSON.stringify(process.execPath),
    "args = [" + JSON.stringify(win32.join(cwd, "src", "index.js")) + "]",
    "cwd = '" + cwd + "'",
    "startup_timeout_sec = 30", "tool_timeout_sec = 7500",
    "env_vars = [", "'NINEROUTER_API_KEY', # credential name only", "]",
    "[mcp_servers.nine-router-gemini.env]",
    'NINEROUTER_EXECUTION_BACKEND = "router-responses-v1"',
    "NINEROUTER_GEMINI_MODEL = 'ag/gemini-3.8-flash'",
    'NINEROUTER_GEMINI_MODELS = "ag/gemini-3.8-flash"',
    "NINEROUTER_ROUTER_BASE_URL = 'http://127.0.0.1:20128'",
    "NINEROUTER_PERMITTED_WORKSPACES = 'D:\\9Router'",
    "NINEROUTER_RUNTIME_ROOT = '" + runtime + "'",
  ].join("\n");
}
function fixture() {
  const config = parseMcpConfig(toml());
  const router = { version: "0.5.81", buildId: "current", contractVersion: 1 };
  const identity = createScopedIdentity({
    sourceDirectory: win32.join(config.cwd, "src"), router, model: config.model,
    companionSha256: "a".repeat(64), dependencyLockSha256: "b".repeat(64),
  });
  const manifest = { runtimeIdentity: identity, releaseId: "c".repeat(12), manifestSha256: "c".repeat(64) };
  const qualification = {
    schemaVersion: 2, identity, approvedAt: "2026-09-19T00:00:00.000Z",
    checks: Object.fromEntries(REQUIRED_SCOPED_CANARY_CHECKS.map((k) => [k, true])),
    release: { releaseId: manifest.releaseId, manifestSha256: manifest.manifestSha256 },
  };
  return { config, qualification, manifest, observedIdentity: identity, router, routerHealth: true,
    commandExists: true, entrypointExists: true, cwdExists: true, canonicalPaths: true,
    apiKeyPresent: true, scratchWritable: true, manifestVerified: true };
}
test("parses literal and escaped basic strings, multiline arrays and comments", () => {
  const config = parseMcpConfig(toml());
  assert.equal(config.command, process.execPath);
  assert.equal(config.cwd, "C:\\release\\integrations");
  assert.deepEqual(config.envVars, ["NINEROUTER_API_KEY"]);
});
test("fails closed on duplicate keys/tables and malformed target values", () => {
  for (const text of [
    toml().replace("startup_timeout_sec = 30", "startup_timeout_sec = 30\nstartup_timeout_sec = 40"),
    toml() + "\n[mcp_servers.nine-router-gemini]",
    toml().replace("'NINEROUTER_API_KEY',", "'NINEROUTER_API_KEY' true,"),
    toml().replace("tool_timeout_sec = 7500", "tool_timeout_sec = nope"),
    toml() + "\nNINEROUTER_API_KEY = 'sentinel-value'",
  ]) assert.throws(() => parseMcpConfig(text), /mcp_config_invalid/);
});
test("matching preflight passes but does not attest Desktop readiness", () => {
  const result = evaluatePreflight(fixture());
  assert.equal(result.pass, true);
  assert.equal(result.readiness, "HOLD");
});
test("does not accept a record with no checks or bootstrap as general qualification", () => {
  for (const mutate of [(q) => { delete q.checks; }, (q) => { q.checks.cancelCleanup = false; },
    (q) => { q.mode = "bootstrap"; }, (q) => { q.approvedAt = null; }]) {
    const c = fixture(); mutate(c.qualification);
    assert.equal(evaluatePreflight(c).pass, false);
  }
});
test("detects release path, Node, endpoint, allowlist, source and lock drift", () => {
  for (const change of [
    { sourceDirectory: "C:\\other-release\\src" }, { node: { path: process.execPath, version: "v999.0" } },
    { routerBaseUrl: "https://router.example.test" }, { allowedModels: ["ag/other"] },
    { companionSha256: "d".repeat(64) }, { dependencyLockSha256: "e".repeat(64) },
  ]) {
    const c = fixture();
    c.qualification.identity = { ...c.qualification.identity, ...change };
    assert.equal(evaluatePreflight(c).status, "qualification_stale");
  }
});
test("router build/version drift is explicit", () => {
  for (const change of [{ buildId: "new" }, { version: "0.5.82" }]) {
    const c = fixture(); c.router = { ...c.router, ...change };
    assert.equal(evaluatePreflight(c).status, "router_identity_mismatch");
  }
});
test("missing qualification, scratch and credential failures are distinct", () => {
  for (const [change, status] of [
    [{ qualification: null }, "qualification_record_missing"],
    [{ scratchWritable: false }, "scratch_root_unwritable"],
    [{ apiKeyPresent: false }, "credential_presence_missing"],
  ]) assert.equal(evaluatePreflight({ ...fixture(), ...change }).status, status);
});
test("unsafe config or timeout below job allowance fails", () => {
  for (const change of [{ toolTimeoutSec: 1800 }, { required: true }, { enabled: false },
    { command: "node" }, { args: ["--eval", "sentinel"] }, { routerBaseUrl: "http://10.0.0.1" }]) {
    const c = fixture(); c.config = { ...c.config, ...change };
    assert.equal(evaluatePreflight(c).status, "config_invalid");
  }
});
test("HTTP metadata probes are bounded, reject status and do not follow redirects", async () => {
  let options;
  assert.deepEqual(await fetchBoundedJson("http://127.0.0.1:20128/api/health", async (_, o) => {
    options = o; return new Response('{"ok":true}');
  }), { ok: true });
  assert.equal(options.redirect, "error"); assert.ok(options.signal);
  await assert.rejects(fetchBoundedJson("unused", async () => new Response("{}", { status: 500 })));
  await assert.rejects(fetchBoundedJson("unused", async () => new Response("x".repeat(4097))));
});
test("actual source tampering fails even when the record and manifest still agree", async () => {
  const root = await createTestScratchDirectory("preflight-");
  try {
    const cwd = win32.join(root, "release");
    const runtime = win32.join(root, "runtime");
    const src = win32.join(cwd, "src");
    await mkdir(src, { recursive: true }); await mkdir(runtime);
    await writeFile(win32.join(src, "index.js"), "export const value = 1;\n");
    const lockPath = win32.join(cwd, "package-lock.json");
    await writeFile(lockPath, "{}");
    const router = { version: "0.5.81", buildId: "fixture", contractVersion: 1 };
    const identity = createScopedIdentity({ sourceDirectory: src, router, model: "ag/gemini-3.8-flash",
      companionSha256: await sourceDigest(src),
      dependencyLockSha256: createHash("sha256").update(await readFile(lockPath)).digest("hex") });
    const manifest = await buildRelease({ sourceDirectory: src, lockPath, runtimeIdentity: identity });
    await writeFile(win32.join(cwd, "release-manifest.json"), JSON.stringify(manifest));
    await writeFile(win32.join(runtime, "qualified-scoped-combination.json"), JSON.stringify({
      schemaVersion: 2, identity, approvedAt: new Date().toISOString(),
      checks: Object.fromEntries(REQUIRED_SCOPED_CANARY_CHECKS.map((k) => [k, true])),
      release: { releaseId: manifest.releaseId, manifestSha256: manifest.manifestSha256 },
    }));
    const configPath = win32.join(root, "config.toml");
    await writeFile(configPath, toml(cwd, runtime));
    const options = { configPath, testScratchRoot: root, environment: { NINEROUTER_API_KEY: "redaction-sentinel" },
      fetchImpl: async (url) => new Response(JSON.stringify(url.endsWith("/api/health") ? { ok: true } : router)) };
    const before = await runPreflight(options);
    assert.equal(before.pass, true, JSON.stringify(before.failures));
    assert.equal(JSON.stringify(before).includes("redaction-sentinel"), false);
    await writeFile(win32.join(src, "index.js"), "export const value = 2;\n");
    const after = await runPreflight(options);
    assert.equal(after.status, "qualification_stale");
    assert.equal(after.checks.releaseBytes, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
