import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createInstalledGeminiCompanion } from "../src/installation.js";
import { createRouterResponsesRuntime } from "../src/router-responses-runtime.js";
import { applyRecovery, summarizeRecoveryJournal } from "../src/file-broker.js";
import { createScopedIdentity, sourceDigest, REQUIRED_SCOPED_CANARY_CHECKS } from "../src/scoped-qualification.js";
import { ensureTestScratchRoot } from "./scratch-root.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");

test("only a matching completed restore resolves the source operation", async () => {
  const source = { version: 1, jobId: "job_links", opId: "source", sequence: 1,
    relativePath: "src\\file.txt", operation: "replace_text", beforeHash: hash("old"),
    intendedAfterHash: hash("new"), backupRef: hash("old"), phase: "prepared" };
  const restore = { ...source, opId: "restore", sequence: 2, operation: "recovery_restore",
    beforeHash: hash("new"), intendedAfterHash: hash("old"), backupRef: hash("new"),
    sourceOpId: "source", sourceBackupRef: hash("old"), phase: "prepared" };
  for (const invalid of [
    { relativePath: "src\\different.txt" }, { sourceBackupRef: hash("wrong") },
    { intendedAfterHash: hash("wrong") }, { sourceOpId: "missing" },
  ]) {
    const candidate = { ...restore, ...invalid };
    const summary = await summarizeRecoveryJournal({ journalDirectory: "C:\\fixture", jobId: source.jobId,
      fs: { readFilePath: async () => [source, candidate, { ...candidate, phase: "applied", sequence: 3 }].map(JSON.stringify).join("\n") } });
    assert.equal(summary.recoveryRequired, true);
    assert.deepEqual(summary.resolvedOperationIds, []);
  }
});

for (const cleanupFails of [false, true]) {
  test(`retains actual applied-sync failure across status and restart; cleanup failure=${cleanupFails}`, async () => {
    const scratch = await ensureTestScratchRoot({ prefix: ".codex-recovery-probe-" });
    const root = await fs.mkdtemp(join(scratch, "2026-09-09-kent-recovery-lifecycle-"));
    const workspace = join(root, "workspace");
    const runtimeRoot = join(root, "runtime");
    const journalDirectory = join(runtimeRoot, "scoped-jobs");
    try {
      await fs.mkdir(join(workspace, "src"), { recursive: true });
      await fs.mkdir(runtimeRoot);
      for (const filename of ["first.txt", "uncertain.txt"]) {
        await fs.writeFile(join(workspace, "src", filename), "old text");
      }
      const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
      const router = { version: "fixture", buildId: "fixture", contractVersion: 1 };
      const identity = createScopedIdentity({
        companionSha256: await sourceDigest(sourceDirectory),
        dependencyLockSha256: hash(await fs.readFile(join(sourceDirectory, "..", "package-lock.json"))),
        router, model: "fixture",
        routerBaseUrl: "https://router.example.test",
      });
      await fs.writeFile(join(runtimeRoot, "qualified-scoped-combination.json"), JSON.stringify({
        schemaVersion: 2, identity, approvedAt: new Date().toISOString(),
        checks: Object.fromEntries(REQUIRED_SCOPED_CANARY_CHECKS.map((name) => [name, true])),
      }));
      const environment = {
        NINEROUTER_EXECUTION_BACKEND: "router-responses-v1", NINEROUTER_GEMINI_MODEL: "fixture",
        NINEROUTER_ROUTER_BASE_URL: "https://router.example.test",
        NINEROUTER_API_KEY: "synthetic-test-key", NINEROUTER_PERMITTED_WORKSPACES: workspace,
        NINEROUTER_RUNTIME_ROOT: runtimeRoot, NINEROUTER_WORKTREE_ROOT: join(root, "unused-jobs"),
      };
      let journalSyncs = 0;
      let modelCalls = 0;
      const companion = await createInstalledGeminiCompanion({ environment, dependencies: {
        openPath: async (path, ...args) => {
          const handle = await fs.open(path, ...args);
          if (path.endsWith(".jsonl")) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              // The second operation's applied bytes exist, but durability was not confirmed.
              if (++journalSyncs === 4) throw Object.assign(new Error("injected sync failure"), { code: "EIO" });
              return sync();
            };
          }
          return handle;
        },
        fetchImpl: async (url) => {
          if (url.endsWith("/api/compatibility")) return new Response(JSON.stringify(router));
          modelCalls += 1;
          return new Response(JSON.stringify({ object: "response", status: "completed", output:
            ["first.txt", "uncertain.txt"].map((filename, index) => ({
              type: "function_call", name: "replace_text", call_id: `call_${index}`,
              arguments: JSON.stringify({ path: `src/${filename}`, expected_sha256: hash("old text"), old_text: "old", new_text: "new" }),
            })),
          }));
        },
        responsesRuntimeFactory: (options) => {
          const actual = createRouterResponsesRuntime(options);
          return cleanupFails ? { ...actual, dispose: async () => {
            await actual.dispose();
            throw new Error("injected cleanup failure");
          } } : actual;
        },
      } });
      const result = await companion.runGeminiTask({
        task: "fixture", workspace, access: "scoped-edit",
        scope: { read: ["src"], write: ["src"], allow_create: false },
      }, { requestDecision: async () => "accept" });
      assert.equal(result.status, "failed");
      assert.equal(result.error.category, "protocol_error");
      assert.equal(result.recoveryRequired, true);
      assert.equal(modelCalls, 1);
      const records = (await fs.readFile(join(journalDirectory, `${result.jobId}.jsonl`), "utf8"))
        .trim().split("\n").map(JSON.parse);
      const uncertainOp = records.find((record) => record.relativePath === "src\\uncertain.txt").opId;
      assert.deepEqual(result.recoveryOperationIds, [uncertainOp]);
      assert.deepEqual(result.recoverySources, cleanupFails ? ["cleanup", "journal"] : ["journal"]);
      const restarted = await createInstalledGeminiCompanion({ environment });
      async function assertStatus(required, sources) {
        for (const instance of [companion, restarted]) {
          const status = await instance.getGeminiStatus(result.jobId);
          assert.equal(status.status, "failed");
          assert.equal(status.recoveryRequired === true, required);
          assert.deepEqual(status.recoverySources ?? [], sources);
          assert.deepEqual(status.filesChanged, ["src\\first.txt", "src\\uncertain.txt"]);
          const cancellation = await instance.cancelGeminiTask(result.jobId);
          assert.equal(cancellation.recoveryRequired === true, required);
        }
      }
      await assertStatus(true, cleanupFails ? ["cleanup", "journal"] : ["journal"]);
      const persisted = JSON.parse(await fs.readFile(join(runtimeRoot, "jobs", `${result.jobId}.json`), "utf8"));
      assert.deepEqual(persisted.recoverySources, result.recoverySources);
      assert.deepEqual(persisted.recoveryOperationIds, [uncertainOp]);
      // Restoring a different successful operation is not evidence for the uncertain one.
      await applyRecovery({ journalDirectory, jobId: result.jobId, workspace,
        relativePath: "src/first.txt", backupRef: hash("old text"), expectedCurrentHash: hash("new text") });
      await assertStatus(true, cleanupFails ? ["cleanup", "journal"] : ["journal"]);
      await applyRecovery({ journalDirectory, jobId: result.jobId, workspace,
        relativePath: "src/uncertain.txt", backupRef: hash("old text"), expectedCurrentHash: hash("new text") });
      await assertStatus(cleanupFails, cleanupFails ? ["cleanup"] : []);
      const lockRetained = await fs.stat(join(runtimeRoot, "execution-owner.json")).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      assert.equal(lockRetained, cleanupFails);
    } finally {
      // Only this test's freshly created fixture is removed; no production lock is touched.
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
