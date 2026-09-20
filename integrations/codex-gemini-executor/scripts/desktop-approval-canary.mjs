#!/usr/bin/env node
// Separate qualification harness. Never writes production qualification or config.
// The immutable candidate's real core, broker and MCP bridge are used unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile, lstat, readdir, realpath, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CASES = Object.freeze(["accept", "decline", "cancel", "timeout"]);
export const BEFORE = "CANARY_9ROUTER";
export const AFTER = "CANARY_9ROUTER_ACCEPTED";
export const TASK = "Read canary-input.txt, replace exactly CANARY_9ROUTER with CANARY_9ROUTER_ACCEPTED using replace_text. Do not touch any other file. If approval is declined, stop and report the denial.";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = (p) => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
const childOf = (base, p) => key(p).startsWith(key(base) + "\\");
const absent = async (p) => lstat(p).then(() => false, (e) => { if (e.code === "ENOENT") return true; throw e; });
export function check(fact, code) { if (!fact) throw new Error(code); }
export async function json(p) {
  check((await lstat(p)).size <= 1024 * 1024, "metadata_too_large");
  return JSON.parse(await readFile(p, "utf8"));
}
export function requestFor(root, scenario) {
  check(CASES.includes(scenario), "scenario_invalid");
  return {
    task: TASK, workspace: win32.join(root, "fixtures", scenario), access: "workspace-write",
    effort: "low", timeout_minutes: scenario === "timeout" ? 1 : 3,
    scope: { read: ["canary-input.txt"], write: ["canary-input.txt"], allow_create: false },
  };
}
export function identifyRequest(root, request) {
  const scenario = CASES.find((c) => isDeepStrictEqual(request, requestFor(root, c)));
  check(scenario !== undefined, "fixed_fixture_request_required");
  return scenario;
}
export async function assertRegular(p, directory = false) {
  const s = await lstat(p);
  check(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1), "fixture_link_or_type_invalid");
  check(key(await realpath(p)) === key(p), "fixture_path_alias");
}
export async function verifyFixture(root, scenario, expected = BEFORE) {
  check(CASES.includes(scenario), "scenario_invalid");
  const workspace = requestFor(root, scenario).workspace;
  for (const p of [root, win32.join(root, "fixtures"), workspace]) await assertRegular(p, true);
  check(isDeepStrictEqual(await readdir(workspace), ["canary-input.txt"]), "fixture_layout_invalid");
  const target = win32.join(workspace, "canary-input.txt");
  await assertRegular(target);
  check((await lstat(target)).size <= 128 && sha(await readFile(target)) === sha(expected), "fixture_content_changed");
  return target;
}
export function verifyIntent(approval) {
  const args = { expected_sha256: sha(BEFORE), new_text: AFTER, old_text: BEFORE, path: "canary-input.txt" };
  check(approval?.type === "write_intent" && approval.operation === "replace_text"
    && approval.path === args.path && approval.expectedSha256 === args.expected_sha256
    && approval.operationFingerprint === sha("replace_text\0" + JSON.stringify(args)), "unexpected_write_intent");
}
export async function verifyHarness(descriptorPath, { router = true } = {}) {
  const d = await json(descriptorPath);
  const root = win32.dirname(descriptorPath);
  check(d.schemaVersion === 1 && key(d.root) === key(root)
    && childOf("C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime\\approval-canaries", root), "harness_root_invalid");
  check(childOf("C:\\tmp\\CodexScratch", d.fixtureRoot), "fixture_root_invalid");
  await assertRegular(root, true);
  for (const [name, digest] of Object.entries(d.artifacts)) {
    check(["desktop-approval-canary.mjs", "Set-DesktopApprovalCanarySafe.ps1", "Set-NineRouterBootstrapSafe.ps1"].includes(name), "harness_artifact_invalid");
    check(sha(await readFile(win32.join(root, name))) === digest, "harness_artifact_changed");
  }
  check(Object.keys(d.artifacts).length === 3, "harness_artifacts_missing");
  const candidate = await json(d.candidatePath + "\\candidate.json");
  check(isDeepStrictEqual(candidate.identity, d.identity) && isDeepStrictEqual(candidate.release, d.release), "candidate_identity_changed");
  check(key(candidate.packageDirectory) === key(win32.join(d.candidatePath, "package")), "candidate_layout_invalid");
  check(key(process.execPath) === key(d.identity.node.path) && process.version === d.identity.node.version, "node_identity_changed");
  const pkg = candidate.packageDirectory;
  const load = (name) => import(pathToFileURL(win32.join(pkg, "src", name)).href);
  const { verifyRelease } = await load("release.js");
  const { sourceDigest, readScopedRouterIdentity } = await load("scoped-qualification.js");
  const manifest = await json(win32.join(pkg, "release-manifest.json"));
  await verifyRelease(manifest, { sourceDirectory: win32.join(pkg, "src"), lockPath: win32.join(pkg, "package-lock.json") });
  check(isDeepStrictEqual(manifest.runtimeIdentity, d.identity) && manifest.manifestSha256 === d.release.manifestSha256, "release_changed");
  check(await sourceDigest(win32.join(pkg, "node_modules")) === candidate.dependenciesSha256, "dependencies_changed");
  check(sha(await readFile(d.host.path)) === d.host.sha256, "host_identity_changed");
  if (router) check(isDeepStrictEqual(await readScopedRouterIdentity({ baseUrl: d.identity.routerBaseUrl }), d.identity.router), "router_identity_mismatch");
  return { d, pkg, load };
}
export function renderConfig(original, d) {
  check(!/^\s*\[[^\r\n]*nine-router-gemini-approval-canary/m.test(original), "canary_registration_exists");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const q = JSON.stringify;
  const block = ["", "[mcp_servers.nine-router-gemini-approval-canary]",
    "command = " + q(d.identity.node.path),
    "args = [" + [win32.join(d.root, "desktop-approval-canary.mjs"), win32.join(d.root, "canary.json")].map(q).join(", ") + "]",
    "cwd = " + q(d.root), "enabled = true", "required = false",
    "startup_timeout_sec = 30", "tool_timeout_sec = 300", 'env_vars = ["NINEROUTER_API_KEY"]', "",
    "[mcp_servers.nine-router-gemini-approval-canary.tools.run_gemini_task]",
    "approval_mode = \"approve\"", "",
  ].join(eol);
  return original + block;
}
export function replaceCanaryConfig(original, d, previous) {
  check(key(d.root) !== key(previous.root), "replacement_must_be_new");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const table = (value) => renderConfig("", value).replaceAll("\n", eol).slice(eol.length);
  const oldTable = table(previous);
  const rootName = "mcp_servers.nine-router-gemini-approval-canary";
  const toolName = rootName + ".tools.run_gemini_task";
  const headers = [...original.matchAll(/^\s*\[([^\r\n]+)\]\s*$/gm)].map((match) => match[1].trim());
  check(headers.filter((name) => name === rootName).length === 1
    && headers.filter((name) => name === toolName).length === 1
    && !headers.some((name) => name.startsWith(rootName + ".") && name !== toolName), "previous_registration_mismatch");
  const first = original.indexOf(oldTable);
  check(first >= 0 && first === original.lastIndexOf(oldTable), "previous_registration_mismatch");
  return original.replace(oldTable, table(d));
}
export async function verifyIdle(d) {
  for (const base of ["runtime", "scripted-runtime"]) {
    const runtime = win32.join(d.fixtureRoot, base);
    check(await absent(win32.join(runtime, "execution-owner.json")), "canary_runtime_busy");
    const jobs = win32.join(runtime, "jobs");
    if (await absent(jobs)) continue;
    for (const name of await readdir(jobs)) {
      const r = await json(win32.join(jobs, name));
      check(["completed", "failed", "cancelled"].includes(r.status) && !r.recoveryRequired, "canary_job_unfinished");
    }
  }
}
export async function createHarnessCore(descriptorPath, { mode = "desktop" } = {}) {
  check(["desktop", "scripted"].includes(mode), "mode_invalid");
  const { d, pkg, load } = await verifyHarness(descriptorPath);
  const base = mode === "desktop" ? d.fixtureRoot : win32.join(d.fixtureRoot, "scripted");
  const runtimeRoot = win32.join(d.fixtureRoot, mode === "desktop" ? "runtime" : "scripted-runtime");
  const evidenceRoot = win32.join(d.root, mode + "-evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const { createScopedCanaryCompanion, createInstalledGeminiCompanion } = await load("installation.js");
  const environment = {
    NINEROUTER_EXECUTION_BACKEND: d.identity.backend, NINEROUTER_ROUTER_BASE_URL: d.identity.routerBaseUrl,
    NINEROUTER_GEMINI_MODEL: d.identity.model, NINEROUTER_GEMINI_MODELS: d.identity.allowedModels.join(";"),
    NINEROUTER_API_KEY: process.env.NINEROUTER_API_KEY,
    NINEROUTER_PERMITTED_WORKSPACES: win32.join(base, "fixtures"), NINEROUTER_RUNTIME_ROOT: runtimeRoot,
    NINEROUTER_WORKTREE_ROOT: win32.join(d.fixtureRoot, mode + "-worktrees"),
  };
  const core = await createScopedCanaryCompanion({ environment });
  const allowedJob = async (id) => {
    for (const scenario of CASES) {
      const p = win32.join(evidenceRoot, scenario + ".job.json");
      if (!await absent(p) && (await json(p)).jobId === id) return;
    }
    throw new Error("foreign_job_denied");
  };
  const wrapped = {
    modelPolicy: core.modelPolicy,
    async runGeminiTask(request, hooks = {}) {
      const scenario = identifyRequest(base, request);
      await verifyHarness(descriptorPath);
      await verifyFixture(base, scenario);
      for (const previous of CASES.slice(0, CASES.indexOf(scenario))) {
        check((await json(win32.join(evidenceRoot, previous + ".result.json"))).status === "pass", "previous_gate_failed");
      }
      // Claim once across all processes; interrupted/failed scenarios require review.
      const startedAt = new Date().toISOString();
      await writeFile(win32.join(evidenceRoot, scenario + ".started.json"), JSON.stringify({ startedAt }), { flag: "wx" });
      const approvals = [];
      const report = { scenario, mode, startedAt, release: d.release, identity: d.identity, host: d.host,
        status: "failed", desktopAcceptance: false, approvals };
      let r;
      try {
        r = await core.runGeminiTask(request, { ...hooks,
          onStarted: async (jobId) => {
            report.jobId = jobId;
            await writeFile(win32.join(evidenceRoot, scenario + ".job.json"), JSON.stringify({ jobId }), { flag: "wx" });
            await hooks.onStarted?.(jobId);
          },
          requestDecision: async (intent) => {
            verifyIntent(intent);
            check(approvals.length === 0, "duplicate_approval_denied");
            await verifyFixture(base, scenario);
            const item = { operation: intent.operation, expectedSha256: intent.expectedSha256,
              operationFingerprint: intent.operationFingerprint, requestedAt: new Date().toISOString() };
            approvals.push(item);
            const decision = await hooks.requestDecision?.(intent);
            check(["accept", "decline", "cancel"].includes(decision), "approval_decision_invalid");
            item.decision = decision;
            item.respondedAt = new Date().toISOString();
            return decision;
          },
        });
        report.result = { jobId: r.jobId, status: r.status, model: r.model, filesChanged: r.filesChanged ?? [],
          recoveryRequired: r.recoveryRequired === true, ...(r.error ? { error: r.error } : {}) };
        const expectedStatus = { accept: "completed", decline: "failed", cancel: "cancelled", timeout: "failed" }[scenario];
        check(r.status === expectedStatus && !r.recoveryRequired && r.model === d.identity.model, "scenario_result_mismatch");
        check(approvals.length === 1, "approval_not_exercised");
        if (scenario === "timeout") {
          check(!approvals[0].decision && Date.now() - Date.parse(startedAt) >= 55_000 && r.error?.category === "timeout", "timeout_not_exercised");
        } else check(approvals[0].decision === scenario, "wrong_ui_decision");
        if (scenario === "decline") check(r.error?.category === "approval_required", "decline_result_mismatch");
        assert.deepEqual(r.filesChanged ?? [], scenario === "accept" ? ["canary-input.txt"] : []);
        await verifyFixture(base, scenario, scenario === "accept" ? AFTER : BEFORE);
        check(await absent(win32.join(runtimeRoot, "execution-owner.json")), "cleanup_unconfirmed");
        report.cleanup = true;
        check((await core.getGeminiStatus(r.jobId)).status === r.status, "status_mismatch");
        check((await core.cancelGeminiTask(r.jobId)).status === r.status, "terminal_cancel_mismatch");
        const restarted = await createInstalledGeminiCompanion({ environment });
        check((await restarted.getGeminiStatus(r.jobId)).status === r.status, "restart_status_mismatch");
        report.restartStatusVerified = true;
        if (scenario === "accept") {
          const { previewRecovery } = await load("file-broker.js");
          const preview = await previewRecovery({ journalDirectory: win32.join(runtimeRoot, "scoped-jobs"), jobId: r.jobId, workspace: request.workspace });
          check(!preview.recoveryRequired && preview.records.length === 1
            && preview.records[0].backupHash === sha(BEFORE) && preview.records[0].currentHash === sha(AFTER), "backup_verification_failed");
          report.backupVerified = true;
        }
        await verifyHarness(descriptorPath);
        report.status = "pass";
        // Desktop UI observations must be attested separately; scripted smoke cannot set this.
      } catch (e) {
        report.error = /^[a-z_]{3,80}$/.test(e.message) ? e.message : "canary_check_failed";
      }
      report.finishedAt = new Date().toISOString();
      await writeFile(win32.join(evidenceRoot, scenario + ".result.json"), JSON.stringify(report, null, 2), { flag: "wx" });
      check(report.status === "pass", report.error ?? "canary_check_failed");
      return r;
    },
    async getGeminiStatus(id) { await allowedJob(id); return core.getGeminiStatus(id); },
    async cancelGeminiTask(id) { await allowedJob(id); return core.cancelGeminiTask(id); },
  };
  return { core: wrapped, d, pkg, load };
}
export async function main(args = process.argv.slice(2)) {
  if (["--verify", "--render", "--verify-replacement", "--render-replacement"].includes(args[0])) {
    const { d } = await verifyHarness(args[1]);
    await verifyIdle(d);
    const protocol = await json(win32.join(d.root, "scripted-protocol.json"));
    check(protocol.status === "pass" && protocol.desktopAcceptance === false
      && isDeepStrictEqual(protocol.scenarios.map((s) => s.scenario), CASES), "scripted_protocol_incomplete");
    for (const c of CASES) await verifyFixture(d.fixtureRoot, c);
    if (args[0].endsWith("-replacement")) {
      const { d: previous } = await verifyHarness(args[2], { router: false });
      await verifyIdle(previous);
      check(key(d.root) !== key(previous.root), "replacement_must_be_new");
      if (args[0] === "--render-replacement") {
        const original = await readFile(args[3], "utf8");
        await writeFile(args[4], replaceCanaryConfig(original, d, previous), { flag: "wx", mode: 0o600 });
      }
    } else if (args[0] === "--render") {
      const original = await readFile(args[2], "utf8");
      await writeFile(args[3], renderConfig(original, d), { flag: "wx", mode: 0o600 });
    }
    process.stdout.write(JSON.stringify({ status: "pass", release: d.release }) + "\n");
    return;
  }
  check(args.length === 1, "descriptor_required");
  const { core, d, pkg, load } = await createHarnessCore(args[0]);
  const { createGeminiMcpServer } = await load("mcp-bridge.js");
  const require = createRequire(win32.join(pkg, "package.json"));
  const { serveStdio } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/server/stdio")).href);
  let traceWrites = Promise.resolve();
  let traceCount = 0;
  const onApprovalTrace = (event) => {
    if (++traceCount > 128) return;
    traceWrites = traceWrites.catch(() => {}).then(() => appendFile(
      win32.join(d.root, "desktop-evidence", "approval-trace.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 }));
    return traceWrites;
  };
  return serveStdio(() => createGeminiMcpServer({ core, onApprovalTrace }), {
    onerror: () => process.stderr.write("Fixture approval transport failed\n"),
  });
}
// Only finite local facts can cross the diagnostic boundary. Never print raw
// exception text, paths, config, environment, or router/provider response bodies.
export function verificationFailure(error) {
  const allowed = new Set([
    "router_identity_unavailable", "router_identity_mismatch", "host_identity_changed",
    "node_identity_changed", "candidate_identity_changed", "candidate_layout_invalid",
    "release_changed", "dependencies_changed", "harness_root_invalid", "fixture_root_invalid",
    "harness_artifact_invalid", "harness_artifact_changed", "harness_artifacts_missing",
    "fixture_link_or_type_invalid", "fixture_path_alias", "fixture_layout_invalid",
    "fixture_content_changed", "canary_runtime_busy", "canary_job_unfinished",
    "canary_registration_exists", "scripted_protocol_incomplete", "metadata_too_large",
    "replacement_must_be_new", "previous_registration_mismatch",
  ]);
  const own = (obj, field) => {
    try { return Object.getOwnPropertyDescriptor(obj ?? {}, field)?.value; } catch { return undefined; }
  };
  const reason = own(own(error, "details"), "reason");
  const message = own(error, "message");
  return { status: "HOLD", error: allowed.has(reason) ? reason : allowed.has(message) ? message : "canary_verification_failed" };
}
if (process.argv[1] && key(fileURLToPath(import.meta.url)) === key(process.argv[1])) {
  main().catch((error) => {
    if (["--verify", "--render", "--verify-replacement", "--render-replacement"].includes(process.argv[2])) {
      process.stdout.write(JSON.stringify(verificationFailure(error)) + "\n");
    } else process.stderr.write("Fixture approval canary failed; retain evidence, no retry\n");
    process.exitCode = 1;
  });
}
