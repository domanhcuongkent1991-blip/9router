import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import { renderBootstrapConfig, assertRuntimeIdle, assertPreviousRuntimeSafe, assertAuthorityConfig } from "../scripts/bootstrap-switch-plan.mjs";
import { parseMcpConfig } from "../scripts/mcp-config.mjs";
import { createTestScratchDirectory } from "./scratch-root.js";

const candidate = {
  packageDirectory: "C:\\candidate\\package", nodePath: "C:\\Program Files\\nodejs\\node.exe",
  runtimeRoot: "C:\\candidate\\runtime", worktreeRoot: "C:\\candidate\\worktrees",
  model: "ag/gemini-3.8-flash", routerBaseUrl: "http://127.0.0.1:20128",
};
const prefix = '# preserve root\nmodel = "unchanged"\n';
const policy = '[mcp_servers.nine-router-gemini.tools.run_gemini_task]\napproval_mode = "approve"\n';
const suffix = '[plugins."example@personal"]\nenabled = false\n';
function input(quote = "'", eol = "\n") {
  const q = (s) => quote === "'" ? "'" + s + "'" : JSON.stringify(s);
  return (prefix + '[mcp_servers.nine-router-gemini]\ncommand = "node"\nargs = ["old"]\ncwd = "old"\n'
    + '[mcp_servers.nine-router-gemini.env]\n'
    + 'NINEROUTER_EXECUTION_BACKEND = ' + q("router-responses-v1") + '\n'
    + 'NINEROUTER_GEMINI_MODEL = ' + q(candidate.model) + '\n'
    + 'NINEROUTER_GEMINI_MODELS = ' + q(candidate.model) + '\n'
    + 'NINEROUTER_ROUTER_BASE_URL = ' + q(candidate.routerBaseUrl) + '\n'
    + policy + suffix).replaceAll("\n", eol);
}
for (const quote of ["'", '"']) for (const eol of ["\n", "\r\n"]) {
  test(`bootstrap renderer preserves unrelated config and approval policy (${JSON.stringify(quote)}, ${JSON.stringify(eol)})`, () => {
    const result = renderBootstrapConfig(input(quote, eol), candidate);
    assert.ok(result.startsWith(prefix.replaceAll("\n", eol)));
    assert.ok(result.endsWith((policy + suffix).replaceAll("\n", eol)));
    const parsed = parseMcpConfig(result);
    assert.equal(parsed.cwd, candidate.packageDirectory);
    assert.equal(parsed.required, false);
    assert.equal(parsed.runtimeRoot, candidate.runtimeRoot);
    assert.deepEqual(parsed.envVars, ["NINEROUTER_API_KEY"]);
    assert.equal(parsed.permittedWorkspaces, "C:\\Users\\Admin\\.codex\\9router-canary-fixture");
    if (eol === "\r\n") assert.equal(result.replaceAll("\r\n", "").includes("\n"), false);
  });
}
test("bootstrap renderer rejects duplicate tables, unknown settings, inline credential and routing drift", () => {
  for (const changed of [
    input() + '[mcp_servers.nine-router-gemini]\ncommand = "other"\n',
    input().replace('command = "node"', 'command = "node"\nurl = "https://example.com"'),
    input().replace('NINEROUTER_EXECUTION_BACKEND', 'NINEROUTER_API_KEY = "fixture-value"\nNINEROUTER_EXECUTION_BACKEND'),
    input().replaceAll(candidate.model, "different-model"),
    input().replace(candidate.routerBaseUrl, "http://127.0.0.1:9999"),
  ]) assert.throws(() => renderBootstrapConfig(changed, candidate));
});
test("authority validation rejects changed timeout, command, model, env and tool restrictions", () => {
  const config = parseMcpConfig(renderBootstrapConfig(input(), candidate));
  const valid = { name: "nine-router-gemini", enabled: true, disabled_reason: null,
    startup_timeout_sec: 30, tool_timeout_sec: 7500, enabled_tools: null, disabled_tools: null,
    transport: { type: "stdio", command: candidate.nodePath, cwd: candidate.packageDirectory,
      args: [win32.join(candidate.packageDirectory, "src", "index.js")], env_vars: ["NINEROUTER_API_KEY"],
      env: { NINEROUTER_EXECUTION_BACKEND: config.backend, NINEROUTER_GEMINI_MODEL: config.model,
        NINEROUTER_GEMINI_MODELS: config.models, NINEROUTER_ROUTER_BASE_URL: config.routerBaseUrl,
        NINEROUTER_PERMITTED_WORKSPACES: config.permittedWorkspaces,
        NINEROUTER_RUNTIME_ROOT: candidate.runtimeRoot, NINEROUTER_WORKTREE_ROOT: candidate.worktreeRoot } } };
  assert.doesNotThrow(() => assertAuthorityConfig(valid, candidate));
  for (const mutate of [
    (x) => x.tool_timeout_sec = 30, (x) => x.transport.command = "node",
    (x) => x.transport.env.NINEROUTER_GEMINI_MODEL = "other",
    (x) => x.transport.env.NINEROUTER_API_KEY = "fixture-value",
    (x) => x.disabled_tools = ["cancel_gemini_task"],
  ]) { const x = structuredClone(valid); mutate(x); assert.throws(() => assertAuthorityConfig(x, candidate)); }
});
test("runtime switch refuses owner lock, nonterminal job, and unresolved recovery", async (t) => {
  const root = await createTestScratchDirectory("bootstrap-idle-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assertRuntimeIdle(root);
  await writeFile(join(root, "execution-owner.json"), "{}");
  await assert.rejects(assertRuntimeIdle(root), /runtime_owner_present/);
  await rm(join(root, "execution-owner.json"));
  await mkdir(join(root, "jobs"));
  for (const status of ["starting", "running", "awaiting_approval", "unknown"]) {
    await writeFile(join(root, "jobs", "job_fixture.json"), JSON.stringify({ status }));
    await assert.rejects(assertRuntimeIdle(root), /runtime_job_nonterminal/);
  }
  await writeFile(join(root, "jobs", "job_fixture.json"), JSON.stringify({ status: "failed", recoveryRequired: true }));
  await assert.rejects(assertRuntimeIdle(root), /runtime_recovery_pending/);
  await writeFile(join(root, "jobs", "job_fixture.json"), JSON.stringify({ status: "completed" }));
  await assertRuntimeIdle(root);
});
test("only pre-boot read-only fixture state can be retained in a stopped previous runtime", async (t) => {
  const root = await createTestScratchDirectory("bootstrap-previous-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "jobs"));
  const record = { status: "running", workspace: "C:\\Users\\Admin\\.codex\\9router-canary-fixture",
    worktreePath: null, updatedAt: "2025-01-01T00:00:00Z" };
  const options = { bootedAt: "2025-01-02T00:00:00Z" };
  const file = join(root, "jobs", "old.json");
  await writeFile(file, JSON.stringify(record));
  assert.deepEqual(await assertPreviousRuntimeSafe(root, options), { staleJobs: 1 });
  await assert.rejects(assertPreviousRuntimeSafe(root), /runtime_job_nonterminal/);
  for (const patch of [{ workspace: "D:\\production" }, { worktreePath: "C:\\write-worktree" },
    { status: "unknown" }, { updatedAt: "2025-01-03T00:00:00Z" }, { recoveryRequired: true }]) {
    await writeFile(file, JSON.stringify({ ...record, ...patch }));
    await assert.rejects(assertPreviousRuntimeSafe(root, options));
  }
});
test("Windows atomic config transaction fixtures", async () => {
  const { stdout } = await promisify(execFile)("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("fixtures/bootstrap-transaction.ps1", import.meta.url))],
    { timeout: 30000, windowsHide: true });
  const report = JSON.parse(stdout);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 7);
});
