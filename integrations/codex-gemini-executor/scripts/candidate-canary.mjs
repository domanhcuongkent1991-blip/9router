#!/usr/bin/env node
// Fixed fixture qualification only. Does not create qualification records.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const exists = (p) => stat(p).then(() => true, () => false);
function externalCanaryRoot(candidateDirectory) {
  const root = process.env.NINEROUTER_CANARY_ROOT;
  if (typeof root !== "string" || !/^[A-Za-z]:[\\/]/u.test(root)) throw new Error("canary_root_required");
  const normalized = win32.normalize(root).toLowerCase().replace(/[\\/]+$/u, "");
  const candidate = win32.normalize(candidateDirectory).toLowerCase().replace(/[\\/]+$/u, "");
  if (normalized === candidate || normalized.startsWith(`${candidate}\\`)) throw new Error("canary_root_inside_candidate");
  return root;
}
export async function runCandidateCanary(descriptorPath) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const { packageDirectory, directory } = descriptor;
  const canaryRoot = externalCanaryRoot(directory);
  const load = (name) => import(pathToFileURL(win32.join(packageDirectory, "src", name)).href);
  const { verifyRelease } = await load("release.js");
  const { sourceDigest, readScopedRouterIdentity } = await load("scoped-qualification.js");
  const { createScopedCanaryCompanion, createInstalledGeminiCompanion } = await load("installation.js");
  const sourceDirectory = win32.join(packageDirectory, "src");
  const manifest = JSON.parse(await readFile(win32.join(packageDirectory, "release-manifest.json"), "utf8"));
  await verifyRelease(manifest, { sourceDirectory, lockPath: win32.join(packageDirectory, "package-lock.json") });
  assert.equal(await sourceDigest(win32.join(packageDirectory, "node_modules")), descriptor.dependenciesSha256);
  const router = await readScopedRouterIdentity({ baseUrl: descriptor.identity.routerBaseUrl });
  assert.deepEqual(router, descriptor.identity.router);
  assert.equal(Boolean(process.env.NINEROUTER_API_KEY), true, "credential_missing");
  const runtime = win32.join(canaryRoot, "runtime");
  const fixtures = win32.join(canaryRoot, "fixtures");
  await mkdir(canaryRoot, { recursive: true });
  await mkdir(fixtures);
  const environment = {
    NINEROUTER_EXECUTION_BACKEND: "router-responses-v1",
    NINEROUTER_GEMINI_MODEL: descriptor.identity.model,
    NINEROUTER_GEMINI_MODELS: descriptor.identity.allowedModels.join(";"),
    NINEROUTER_API_KEY: process.env.NINEROUTER_API_KEY,
    NINEROUTER_ROUTER_BASE_URL: descriptor.identity.routerBaseUrl,
    NINEROUTER_PERMITTED_WORKSPACES: fixtures,
    NINEROUTER_RUNTIME_ROOT: runtime,
    NINEROUTER_WORKTREE_ROOT: win32.join(canaryRoot, "worktrees"),
  };
  const companion = await createScopedCanaryCompanion({ environment });
  const report = {
    scope: "direct installed source and broker; scripted decisions, not Desktop UI",
    identity: descriptor.identity, release: descriptor.release, scenarios: [],
    desktopAcceptance: false, qualificationWritten: false, status: "running",
  };
  const reportPath = win32.join(directory, "live-canary-report.json");
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
  const summarize = (r) => ({
    jobId: r.jobId, status: r.status, model: r.model, filesChanged: r.filesChanged ?? [],
    recoveryRequired: r.recoveryRequired === true,
    ...(r.error ? { error: { category: r.error.category, source: r.error.source, stage: r.error.stage, reason: r.error.reason } } : {}),
  });
  const clean = async () => assert.equal(await exists(win32.join(runtime, "execution-owner.json")), false, "owner_lock_retained");
  try {
    // Plain read plus persisted terminal status and cleanup.
    const readWorkspace = win32.join(fixtures, "read");
    await mkdir(readWorkspace);
    const marker = Buffer.from("CANARY_READ_19_BYTE"); // 19 bytes
    await writeFile(win32.join(readWorkspace, "canary-marker.txt"), marker);
    const readRequest = {
      task: "Read only canary-marker.txt and reply with its byte count. Do not write, create, list, or search files.",
      workspace: readWorkspace, access: "read-only", effort: "low", timeout_minutes: 3,
      scope: { read: ["canary-marker.txt"], write: [], allow_create: false },
    };
    let started = Date.now();
    const result = await companion.runGeminiTask(readRequest);
    report.scenarios.push({ name: "read-only", ...summarize(result), elapsedMs: Date.now() - started });
    await save();
    assert.equal(result.status, "completed", "read_failed");
    assert.match(result.finalAnswer, new RegExp("\\b" + marker.length + "\\b"));
    assert.deepEqual(result.filesChanged, []);
    assert.equal(hash(await readFile(win32.join(readWorkspace, "canary-marker.txt"))), hash(marker));
    assert.equal((await companion.getGeminiStatus(result.jobId)).status, "completed");
    const restarted = await createInstalledGeminiCompanion({ environment });
    assert.equal((await restarted.getGeminiStatus(result.jobId)).status, "completed");
    await clean();
    report.scenarios.at(-1).statusAfterRestart = "completed";
    report.scenarios.at(-1).cleanup = true;
    // Explicitly authorize only this exact fixture replacement, never shell/Git.
    for (const decision of ["accept", "decline"]) {
      const workspace = win32.join(fixtures, decision);
      await mkdir(workspace);
      const target = win32.join(workspace, "canary-input.txt");
      await writeFile(target, "CANARY_9ROUTER");
      const decisions = [];
      const r = await companion.runGeminiTask({
        task: "Read canary-input.txt, replace exactly CANARY_9ROUTER with CANARY_9ROUTER_ACCEPTED using replace_text. Do not touch any other file. If approval is declined, stop and report the denial.",
        workspace, access: "workspace-write", effort: "low", timeout_minutes: 3,
        scope: { read: ["canary-input.txt"], write: ["canary-input.txt"], allow_create: false },
      }, { requestDecision: async (prompt) => {
        assert.equal(prompt.type, "write_intent");
        assert.equal(prompt.operation, "replace_text");
        assert.equal(prompt.path, "canary-input.txt");
        decisions.push(decision);
        return decision;
      } });
      report.scenarios.push({ name: "write-" + decision, ...summarize(r), decisionCount: decisions.length });
      await save();
      assert.ok(decisions.length >= 1, "approval_not_exercised");
      assert.equal(r.recoveryRequired === true, false);
      const text = await readFile(target, "utf8");
      if (decision === "accept") {
        assert.equal(r.status, "completed");
        assert.equal(text, "CANARY_9ROUTER_ACCEPTED");
        assert.deepEqual(r.filesChanged, ["canary-input.txt"]);
      } else {
        assert.equal(r.status, "failed");
        assert.equal(r.error?.category, "approval_required");
        assert.equal(text, "CANARY_9ROUTER");
        assert.deepEqual(r.filesChanged, []);
      }
      await clean();
      report.scenarios.at(-1).cleanup = true;
    }
    // Cancellation during setup: owning instance stops the job; no replay.
    let cancelResult;
    let cancelPromise;
    const cancelled = await companion.runGeminiTask(readRequest, {
      onStarted: async (jobId) => { cancelPromise = companion.cancelGeminiTask(jobId); },
    });
    cancelResult = await cancelPromise;
    report.scenarios.push({ name: "cancel-setup", ...summarize(cancelled), cancelStatus: cancelResult?.status });
    await save();
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.filesChanged ?? [], []);
    await clean();
    report.scenarios.at(-1).cleanup = true;
    // End identity must be unchanged. A new build invalidates all this evidence.
    assert.deepEqual(await readScopedRouterIdentity({ baseUrl: descriptor.identity.routerBaseUrl }), router);
    await verifyRelease(manifest, { sourceDirectory, lockPath: win32.join(packageDirectory, "package-lock.json") });
    report.status = "pass";
  } catch (error) {
    report.status = "failed";
    report.stopReason = error.code === "ERR_ASSERTION" ? "scenario_assertion_failed" : "candidate_canary_failed";
  } finally {
    // Retain an uncertain owner; never delete a lock just to make this pass.
    if (await exists(win32.join(runtime, "execution-owner.json"))) {
      report.cleanup = "owner_lock_retained_after_failure";
    }
  }
  await save();
  return { status: report.status, reportPath, scenarios: report.scenarios, desktopAcceptance: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = 1;
    const r = await runCandidateCanary(process.argv[2]);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exitCode = r.status === "pass" ? 0 : 1;
  } catch { process.stderr.write("Candidate canary setup failed; no retry.\n"); process.exitCode = 1; }
}
