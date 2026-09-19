#!/usr/bin/env node
// Explicit fixture-only recovery after the scripted write; never production recovery.
import { writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { check, json, verifyHarness, verifyIdle, verifyFixture, BEFORE, AFTER, sha, requestFor } from "./desktop-approval-canary.mjs";
export async function checkRecovery(descriptorPath) {
  const { d, load } = await verifyHarness(descriptorPath);
  check((await json(win32.join(d.root, "scripted-protocol.json"))).status === "pass", "protocol_gate_required");
  await verifyIdle(d);
  const accepted = await json(win32.join(d.root, "scripted-evidence", "accept.result.json"));
  check(accepted.status === "pass" && accepted.backupVerified, "accepted_fixture_required");
  const base = win32.join(d.fixtureRoot, "scripted");
  await verifyFixture(base, "accept", AFTER);
  await writeFile(win32.join(d.root, "recovery.started.json"), JSON.stringify({ at: new Date().toISOString() }), { flag: "wx" });
  const { applyRecovery, previewRecovery } = await load("file-broker.js");
  const { createExecutionOwner } = await load("execution-owner.js");
  const runtime = win32.join(d.fixtureRoot, "scripted-runtime");
  const owner = await createExecutionOwner({ directory: runtime }).acquire();
  const args = { journalDirectory: win32.join(runtime, "scoped-jobs"), jobId: accepted.jobId,
    workspace: requestFor(base, "accept").workspace, relativePath: "canary-input.txt", backupRef: sha(BEFORE) };
  let report = { status: "failed", scope: "scripted fixture recovery only", desktopAcceptance: false, jobId: accepted.jobId };
  try {
    let refused = false;
    try { await applyRecovery({ ...args, expectedCurrentHash: "a".repeat(64) }); }
    catch (e) { check(e.code === "file_conflict", "unexpected_recovery_error"); refused = true; }
    check(refused, "hash_guard_missing");
    await verifyFixture(base, "accept", AFTER);
    const result = await applyRecovery({ ...args, expectedCurrentHash: sha(AFTER) });
    check(result.status === "restored" && result.sha256 === sha(BEFORE), "restore_failed");
    await verifyFixture(base, "accept", BEFORE);
    const preview = await previewRecovery(args);
    check(preview.recoveryRequired === false, "recovery_uncertain");
    report = { ...report, status: "pass", hashGuard: true, backupRestore: true, journalVerified: true };
  } catch (e) { report.error = /^[a-z_]+$/.test(e.message) ? e.message : "recovery_check_failed"; }
  finally { await owner.release(); }
  await verifyIdle(d);
  await writeFile(win32.join(d.root, "recovery.result.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  return report;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkRecovery(process.argv[2]).then((r) => { process.stdout.write(JSON.stringify(r) + "\n"); process.exitCode = r.status === "pass" ? 0 : 1; })
    .catch(() => { process.stderr.write("Fixture recovery failed; retain evidence\n"); process.exitCode = 1; });
}
