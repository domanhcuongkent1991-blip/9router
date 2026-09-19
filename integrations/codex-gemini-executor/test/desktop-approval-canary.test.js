import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTestScratchDirectory } from "./scratch-root.js";
import { requestFor, identifyRequest, verifyFixture, verifyIntent, renderConfig, sha, BEFORE, AFTER, CASES } from "../scripts/desktop-approval-canary.mjs";
import { validateGeminiRequest } from "../src/request.js";
const root = "C:\\tmp\\CodexScratch\\approval-test";

test("canary permits only exact fixture requests, with no caller routing or policy overrides", () => {
  for (const c of CASES) assert.equal(identifyRequest(root, requestFor(root, c)), c);
  const valid = requestFor(root, "accept");
  for (const patch of [{ task: "arbitrary" }, { workspace: "D:\\9Router" }, { model: "other" },
    { access: "read-only" }, { timeout_minutes: 10 }, { session_id: "old" },
    { scope: { ...valid.scope, write: ["other.txt"] } }, { scope: { ...valid.scope, allow_create: true } }]) {
    assert.throws(() => identifyRequest(root, { ...valid, ...patch }), /fixed_fixture_request_required/);
  }
});
test("canary binds approved text, path, hash and operation; altered model calls are denied", () => {
  const args = { expected_sha256: sha(BEFORE), new_text: AFTER, old_text: BEFORE, path: "canary-input.txt" };
  const valid = { type: "write_intent", operation: "replace_text", path: args.path,
    expectedSha256: args.expected_sha256, operationFingerprint: sha("replace_text\0" + JSON.stringify(args)) };
  assert.doesNotThrow(() => verifyIntent(valid));
  for (const patch of [{ operation: "create_text" }, { path: "other.txt" }, { expectedSha256: "a".repeat(64) },
    { operationFingerprint: sha("replace_text\0" + JSON.stringify({ ...args, new_text: "arbitrary" })) }]) {
    assert.throws(() => verifyIntent({ ...valid, ...patch }), /unexpected_write_intent/);
  }
});
test("prepared fixture validates in the real request path; missing input fails before execution", async () => {
  const taskRoot = await createTestScratchDirectory("desktop-approval-");
  try {
    const request = requestFor(taskRoot, "accept");
    await mkdir(request.workspace, { recursive: true });
    await assert.rejects(verifyFixture(taskRoot, "accept"), /fixture_layout_invalid/);
    await assert.rejects(validateGeminiRequest(request, { permittedWorkspaceRoots: [request.workspace],
      installationPolicy: { requireScopedProfile: true } }), { code: "scope_denied", details: { reason: "path_unavailable" } });
    await writeFile(win32.join(request.workspace, "canary-input.txt"), BEFORE);
    await verifyFixture(taskRoot, "accept");
    const resolved = await validateGeminiRequest(request, { permittedWorkspaceRoots: [request.workspace],
      installationPolicy: { requireScopedProfile: true } });
    assert.equal(resolved.scoped, true);
    assert.equal(resolved.access, "scoped-edit");
    await writeFile(win32.join(request.workspace, "canary-input.txt"), "unexpected");
    await assert.rejects(verifyFixture(taskRoot, "accept"), /fixture_content_changed/);
  } finally { await rm(taskRoot, { recursive: true, force: true }); }
});
test("fixture rejects unapproved extra files", async () => {
  const taskRoot = await createTestScratchDirectory("desktop-approval-");
  try {
    const workspace = requestFor(taskRoot, "decline").workspace;
    await mkdir(workspace, { recursive: true });
    await writeFile(win32.join(workspace, "canary-input.txt"), BEFORE);
    await writeFile(win32.join(workspace, "unexpected.txt"), "fixture");
    await assert.rejects(verifyFixture(taskRoot, "decline"), /fixture_layout_invalid/);
  } finally { await rm(taskRoot, { recursive: true, force: true }); }
});
for (const eol of ["\n", "\r\n"]) test(`canary config is additive and optional (${JSON.stringify(eol)})`, () => {
  const original = ['model = "existing"', '[mcp_servers.nine-router-gemini]', 'command = "unchanged"', ''].join(eol);
  const rendered = renderConfig(original, { root, identity: { node: { path: "C:\\Program Files\\nodejs\\node.exe" } } });
  assert.ok(rendered.startsWith(original));
  assert.match(rendered, /required = false/);
  assert.equal((rendered.match(/\[mcp_servers\.nine-router-gemini\]/g) ?? []).length, 1);
  assert.doesNotMatch(rendered, /NINEROUTER_API_KEY\s*=/);
  assert.throws(() => renderConfig(rendered, {}), /canary_registration_exists/);
});
test("safe writer parses on Windows PowerShell and preserves Apply across helper import", async () => {
  const path = new URL("../scripts/Set-DesktopApprovalCanarySafe.ps1", import.meta.url);
  const source = await readFile(path, "utf8");
  assert.ok(source.indexOf('$requestedApply = $Apply') < source.indexOf('. (Join-Path'));
  assert.equal((source.match(/if \(\$requestedApply\)/g) ?? []).length, 2);
  const r = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-Command",
    "$errors=$null; $tokens=$null; [Management.Automation.Language.Parser]::ParseFile('" + fileURLToPath(path).replaceAll("'", "''") + "',[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count){exit 1}"], { windowsHide: true });
  assert.equal(r.status, 0);
});
test("private preview resolves the relative catalog without modifying config or accepting traversal", () => {
  const r = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./fixtures/desktop-approval-writer.ps1", import.meta.url))], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { passed: 5, failed: 0 });
});
