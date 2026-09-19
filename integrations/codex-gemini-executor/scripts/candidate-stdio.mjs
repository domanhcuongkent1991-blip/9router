#!/usr/bin/env node
// Uses the normal installed stdio entrypoint and its fixed bootstrap gate.
// Never changes Desktop registration or writes general qualification.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const exists = (p) => stat(p).then(() => true, () => false);
export async function openStdio(entry, cwd, env) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let nextId = 0;
  let stderrBytes = 0;
  let closed = false;
  child.stderr.on("data", (b) => { stderrBytes += b.length; });
  const closedPromise = new Promise((resolve) => child.once("close", (code) => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("mcp_child_closed")); }
    pending.clear();
    resolve(code);
  }));
  child.on("error", () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("mcp_spawn_failed")); }
    pending.clear();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error();
      const message = JSON.parse(line);
      const p = pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(new Error("mcp_rpc_error"));
      else p.resolve(message.result);
    } catch {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("mcp_response_invalid")); }
      pending.clear();
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("mcp_child_closed"));
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("mcp_deadline")); },
      method === "tools/call" ? 190000 : 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    send,
    async initialize() {
      const result = await send("initialize", {
        protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "kent-candidate-stdio", version: "1.0" },
      });
      assert.ok(result.protocolVersion);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      return result.protocolVersion;
    },
    async close() {
      child.stdin.end();
      let timer;
      const result = await Promise.race([closedPromise, new Promise((resolve) => {
        timer = setTimeout(() => resolve("deadline"), 5000);
      })]);
      clearTimeout(timer);
      if (result === "deadline") { child.kill(); await closedPromise; }
      lines.close();
      return { closed, exitCode: child.exitCode, forced: result === "deadline", stderrBytes };
    },
  };
}
export async function probeCandidate(descriptorPath, offlineLogPath) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const { directory, packageDirectory: pkg } = descriptor;
  const load = (name) => import(pathToFileURL(win32.join(pkg, "src", name)).href);
  const { SCOPED_BOOTSTRAP_PROFILE, REQUIRED_SCOPED_BOOTSTRAP_CHECKS,
    requireScopedBootstrap, readScopedRouterIdentity, sourceDigest } = await load("scoped-qualification.js");
  const { verifyRelease } = await load("release.js");
  const manifest = JSON.parse(await readFile(win32.join(pkg, "release-manifest.json"), "utf8"));
  await verifyRelease(manifest, { sourceDirectory: win32.join(pkg, "src"), lockPath: win32.join(pkg, "package-lock.json") });
  assert.equal(await sourceDigest(win32.join(pkg, "node_modules")), descriptor.dependenciesSha256);
  assert.deepEqual(await readScopedRouterIdentity({ baseUrl: descriptor.identity.routerBaseUrl }), descriptor.identity.router);
  const livePath = win32.join(directory, "live-canary-report.json");
  const liveBytes = await readFile(livePath);
  const live = JSON.parse(liveBytes);
  assert.equal(live.status, "pass");
  assert.deepEqual(live.identity, descriptor.identity);
  assert.deepEqual(live.release, descriptor.release);
  assert.equal(live.scenarios.length, 4);
  assert.ok(live.scenarios.every((s) => s.cleanup === true && s.recoveryRequired === false));
  const log = await readFile(offlineLogPath, "utf8");
  const tests = Number(log.match(/(?:ℹ |# )tests (\d+)/u)?.[1]);
  const passed = Number(log.match(/(?:ℹ |# )pass (\d+)/u)?.[1]);
  assert.ok(tests >= 347 && passed === tests);
  assert.match(log, /(?:ℹ |# )fail 0/u);
  assert.match(log, /(?:ℹ |# )skipped 0/u);
  const runtime = win32.join(directory, "bootstrap-runtime");
  const env = { ...process.env,
    NINEROUTER_EXECUTION_BACKEND: "router-responses-v1",
    NINEROUTER_GEMINI_MODEL: descriptor.identity.model,
    NINEROUTER_GEMINI_MODELS: descriptor.identity.allowedModels.join(";"),
    NINEROUTER_ROUTER_BASE_URL: descriptor.identity.routerBaseUrl,
    NINEROUTER_PERMITTED_WORKSPACES: SCOPED_BOOTSTRAP_PROFILE.workspace,
    NINEROUTER_RUNTIME_ROOT: runtime, NINEROUTER_WORKTREE_ROOT: win32.join(directory, "bootstrap-worktrees"),
  };
  const mapping = {
    responsesContract: { kind: "live", scenario: "read-only and write-accept" },
    brokerReadWrite: { kind: "live", scenario: "read-only, write-accept, write-decline; disk hashes verified" },
    scopeDenials: { kind: "offline", tests: "job-scope.test.js and file-broker.test.js" },
    cancelCleanup: { kind: "live", scenario: "cancel-setup, cancelled, owner released" },
    recovery: { kind: "offline", tests: "recovery-lifecycle.test.js and file-broker.test.js" },
    runtimeIsolation: { kind: "offline-and-live", tests: "installation.test.js; candidate fixture/runtime roots" },
  };
  assert.deepEqual(Object.keys(mapping).sort(), [...REQUIRED_SCOPED_BOOTSTRAP_CHECKS].sort());
  const evidence = {
    schemaVersion: 2, mode: "bootstrap", identity: descriptor.identity, approvedAt: new Date().toISOString(),
    checks: Object.fromEntries(Object.keys(mapping).map((k) => [k, true])), bootstrap: SCOPED_BOOTSTRAP_PROFILE,
    evidence: { mapping, offline: { path: offlineLogPath, sha256: sha(log), tests },
      live: { path: livePath, sha256: sha(liveBytes) }, desktopAcceptance: false },
  };
  requireScopedBootstrap(descriptor.identity, evidence);
  const evidencePath = win32.join(directory, "bootstrap-evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: "wx" });
  const approval = execFileSync(process.execPath, [win32.join(pkg, "src", "qualification-cli.js"), "bootstrap", evidencePath],
    { env, cwd: pkg, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
  const report = { scope: "production stdio with fixed bootstrap; not Desktop acceptance",
    status: "running", release: descriptor.release, bootstrap: JSON.parse(approval), checks: {}, evidencePath };
  const reportPath = win32.join(directory, "bootstrap-stdio-report.json");
  let client;
  try {
    client = await openStdio(win32.join(pkg, "src", "index.js"), pkg, env);
    report.protocol = await client.initialize(); report.checks.initialize = true;
    const list = await client.send("tools/list");
    assert.deepEqual(list.tools.map((t) => t.name).sort(), ["cancel_gemini_task", "get_gemini_status", "run_gemini_task"]);
    const schema = list.tools.find((t) => t.name === "run_gemini_task").inputSchema;
    assert.equal(schema.additionalProperties, false);
    for (const k of ["model", "provider", "base_url"]) assert.equal(Object.hasOwn(schema.properties, k), false);
    report.checks.toolsList = true;
    const args = {
      task: SCOPED_BOOTSTRAP_PROFILE.task, workspace: SCOPED_BOOTSTRAP_PROFILE.workspace, access: "read-only",
      effort: "low", timeout_minutes: 3,
      scope: { read: [...SCOPED_BOOTSTRAP_PROFILE.read], write: [], allow_create: false },
    };
    const started = Date.now();
    const result = await client.send("tools/call", { name: "run_gemini_task", arguments: args });
    const job = result.structuredContent;
    // Keep only bounded result facts, not upstream errors or arbitrary bodies.
    report.job = { jobId: job?.jobId, status: job?.status, isError: result.isError === true, elapsedMs: Date.now() - started };
    assert.equal(result.isError === true, false);
    assert.equal(job.status, "completed");
    const expected = (await stat(win32.join(args.workspace, "canary-marker.txt"))).size;
    assert.match(job.finalAnswer, new RegExp("\\b" + expected + "\\b"));
    assert.deepEqual(job.filesChanged, []);
    report.job.expectedBytes = expected; report.job.filesChanged = []; report.checks.fixedReadOnly = true;
    for (const name of ["get_gemini_status", "cancel_gemini_task"]) {
      const r = await client.send("tools/call", { name, arguments: { job_id: job.jobId } });
      assert.equal(r.structuredContent.status, "completed");
    }
    report.checks.status = true; report.checks.cancelTerminalIdempotent = true;
    report.firstClose = await client.close(); client = null;
    assert.equal(report.firstClose.forced, false);
    client = await openStdio(win32.join(pkg, "src", "index.js"), pkg, env);
    await client.initialize();
    const restarted = await client.send("tools/call", { name: "get_gemini_status", arguments: { job_id: job.jobId } });
    assert.equal(restarted.structuredContent.status, "completed"); assert.deepEqual(restarted.structuredContent.filesChanged, []);
    report.checks.statusAfterRestart = true;
    report.secondClose = await client.close(); client = null;
    assert.equal(report.secondClose.forced, false);
    assert.equal(await exists(win32.join(runtime, "execution-owner.json")), false);
    report.checks.ownerReleased = true;
    assert.deepEqual(await readScopedRouterIdentity({ baseUrl: descriptor.identity.routerBaseUrl }), descriptor.identity.router);
    report.status = "pass";
  } catch {
    report.status = "failed"; report.reason = "mcp_candidate_assertion_failed";
  } finally {
    if (client) report.failureClose = await client.close();
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  }
  return { ...report, reportPath, desktopAcceptance: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = 1;
  try {
    const report = await probeCandidate(process.argv[2], process.argv[3]);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.status === "pass" ? 0 : 1;
  } catch { process.stderr.write("Candidate stdio setup failed; retained evidence must be inspected.\n"); }
}
