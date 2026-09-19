import test from "node:test";
import assert from "node:assert/strict";

import {
  SCOPED_BOOTSTRAP_PROFILE,
  REQUIRED_SCOPED_BOOTSTRAP_CHECKS,
  REQUIRED_SCOPED_CANARY_CHECKS,
  createScopedIdentity,
  matchesScopedBootstrapRequest,
  requireScopedBootstrap,
  requireScopedQualification,
} from "../src/scoped-qualification.js";
import { main as qualificationMain, promoteScopedQualification } from "../src/qualification-cli.js";

function identity(overrides = {}) {
  return createScopedIdentity({
    companionSha256: "a".repeat(64),
    dependencyLockSha256: "b".repeat(64),
    router: { version: "0.5.65", buildId: "build_1", contractVersion: 1 },
    model: "ag/gemini-test",
    ...overrides,
  });
}

function evidence(value) {
  return {
    schemaVersion: 2,
    identity: value,
    approvedAt: "2026-09-08T00:00:00.000Z",
    checks: Object.fromEntries(REQUIRED_SCOPED_CANARY_CHECKS.map((name) => [name, true])),
  };
}

const RELEASE = { releaseId: "0123456789ab", manifestSha256: "c".repeat(64) };

function releaseEvidence(value) {
  return { ...evidence(value), release: { ...RELEASE } };
}

function releaseBuilder(overrides = {}) {
  return async () => ({ schemaVersion: 1, backend: "router-responses-v1", ...RELEASE, ...overrides });
}

test("accepts only a matching scoped Responses qualification profile", () => {
  const current = identity();
  const fingerprint = requireScopedQualification(current, evidence(current));
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
});

test("rejects legacy backend, missing scoped checks, and identity drift", () => {
  const current = identity();
  assert.throws(() => requireScopedQualification(current, {
    ...evidence(current), schemaVersion: 1,
  }), { code: "app_server_incompatible" });
  const incomplete = evidence(current);
  incomplete.checks.recovery = false;
  assert.throws(() => requireScopedQualification(current, incomplete), { code: "app_server_incompatible" });
  assert.throws(() => requireScopedQualification(current, evidence(identity({ model: "ag/other" }))), { code: "app_server_incompatible" });
});

test("rejects stale identity evidence", () => {
  const current = identity();
  assert.throws(() => requireScopedQualification(current, evidence(identity({ model: "ag/other" }))), {
    code: "app_server_incompatible",
  });
});

test("binds source location, endpoint, provider and sorted model allowlist", () => {
  const current = identity();
  for (const change of [{ sourceDirectory: "C:\\other\\src" }, { routerBaseUrl: "https://router.example.test" },
    { allowedModels: ["ag/gemini-test", "ag/other"] }]) {
    assert.throws(() => requireScopedQualification(current, evidence(identity(change))));
  }
  assert.throws(() => requireScopedQualification(current, evidence({ ...current, provider: "other" })));
  assert.throws(() => requireScopedQualification(current, evidence({ ...current, policyVersion: 1 })));
  assert.throws(() => requireScopedQualification(current, { ...evidence(current), mode: "bootstrap" }));
});

test("rejects changed router buildId evidence", () => {
  const current = identity();
  assert.throws(() => requireScopedQualification(current,
    evidence(identity({ router: { version: "0.5.65", buildId: "build_stale", contractVersion: 1 } }))), {
    code: "app_server_incompatible",
  });
});

test("rejects changed companion source digest evidence", () => {
  const current = identity();
  assert.throws(() => requireScopedQualification(current, evidence(identity({ companionSha256: "c".repeat(64) }))), {
    code: "app_server_incompatible",
  });
});

test("rejects changed dependency lock digest evidence", () => {
  const current = identity();
  assert.throws(() => requireScopedQualification(current, evidence(identity({ dependencyLockSha256: "d".repeat(64) }))), {
    code: "app_server_incompatible",
  });
});

test("rejects malformed or incomplete scoped evidence", () => {
  const current = identity();
  const variants = [
    { ...evidence(current), approvedAt: "not-a-date" },
    { ...evidence(current), identity: { ...current, router: { version: "0.5.65", contractVersion: 1 } } },
    { ...evidence(current), checks: { ...evidence(current).checks, runtimeIsolation: false } },
  ];
  for (const candidate of variants) {
    assert.throws(() => requireScopedQualification(current, candidate), {
      code: "app_server_incompatible",
      details: { stage: "qualification", reason: "scoped_combination_not_qualified" },
    });
  }
});

test("scoped promote preserves prior record bytes before replacement", async () => {
  const runtimeRoot = "C:\\candidate\\runtime";
  const target = `${runtimeRoot}\\qualified-scoped-combination.json`;
  const previous = Buffer.from('{\r\n  "old": true\r\n}\r\n', "utf8");
  const files = new Map([[target, previous]]);
  const writes = [];
  let id = 0;
  const fingerprint = await promoteScopedQualification({
    identity: identity(), evidence: releaseEvidence(identity()), runtimeRoot,
    buildRelease: releaseBuilder(),
    io: {
      readFile: async (path) => {
        if (!files.has(path)) { const error = new Error("missing"); error.code = "ENOENT"; throw error; }
        return files.get(path);
      },
      writeFile: async (path, data) => { writes.push(path); files.set(path, data); },
      rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    },
    randomId: () => ["prior", "replacement"][id++],
  });
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(files.get(`${target}.prior.previous`), previous);
  assert.equal(writes[0], `${target}.prior.previous`);
  assert.notDeepEqual(files.get(target), previous);
  assert.deepEqual(JSON.parse(files.get(target)).identity, identity());
  assert.deepEqual(JSON.parse(files.get(target)).release, RELEASE);
});

test("scoped promote fails closed when the release provenance is missing or stale", async () => {
  const runtimeRoot = "C:\\candidate\\runtime";
  const target = `${runtimeRoot}\\qualified-scoped-combination.json`;
  const writes = [];
  const io = {
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    writeFile: async (path) => writes.push(path),
    rename: async () => {},
  };
  const rejectsReason = async (promise, reason) => assert.rejects(promise,
    (error) => error.code === "app_server_incompatible" && error.details.reason === reason);
  await rejectsReason(promoteScopedQualification({
    identity: identity(), evidence: evidence(identity()), runtimeRoot, buildRelease: releaseBuilder(), io,
  }), "release_provenance_missing");
  await rejectsReason(promoteScopedQualification({
    identity: identity(), evidence: releaseEvidence(identity()), runtimeRoot, io,
  }), "release_provenance_missing");
  await rejectsReason(promoteScopedQualification({
    identity: identity(), evidence: releaseEvidence(identity()), runtimeRoot,
    buildRelease: releaseBuilder({ manifestSha256: "d".repeat(64) }), io,
  }), "release_manifest_mismatch");
  await rejectsReason(promoteScopedQualification({
    identity: identity(), evidence: { ...releaseEvidence(identity()), release: { ...RELEASE, releaseId: "ffffffffffff" } },
    runtimeRoot, buildRelease: releaseBuilder(), io,
  }), "release_manifest_mismatch");
  assert.deepEqual(writes, []);
});

test("scoped promote fails closed when prior record preservation fails", async () => {
  const runtimeRoot = "C:\\candidate\\runtime";
  const target = `${runtimeRoot}\\qualified-scoped-combination.json`;
  const previous = Buffer.from("existing bytes", "utf8");
  const files = new Map([[target, previous]]);
  const writes = [];
  await assert.rejects(promoteScopedQualification({
    identity: identity(), evidence: releaseEvidence(identity()), runtimeRoot,
    buildRelease: releaseBuilder(),
    io: {
      readFile: async () => previous,
      writeFile: async (path) => {
        writes.push(path);
        throw Object.assign(new Error("backup blocked"), { code: "EACCES" });
      },
      rename: async () => { throw new Error("must not replace"); },
    },
    randomId: () => "prior",
  }));
  assert.deepEqual(files.get(target), previous);
  assert.deepEqual(writes, [`${target}.prior.previous`]);
});

test("rejects bootstrap on the legacy backend before any qualification I/O", async () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      NINEROUTER_EXECUTION_BACKEND: "legacy-app-server",
      NINEROUTER_RUNTIME_ROOT: "C:\\candidate\\runtime",
      NINEROUTER_WORKTREE_ROOT: "C:\\candidate\\jobs",
      NINEROUTER_CODEX_APP_SERVER_PATH: "C:\\CodexDesktop\\codex.exe",
      NINEROUTER_CODEX_APP_SERVER_ROOT: "C:\\CodexDesktop",
      NINEROUTER_CODEX_BASELINE_VERSION: "codex-cli 1.0.0",
      NINEROUTER_CODEX_BASELINE_SHA256: "a".repeat(64),
      NINEROUTER_GEMINI_MODEL: "gemini-fixed",
      NINEROUTER_API_KEY: "test-key",
      NINEROUTER_PERMITTED_WORKSPACES: "D:\\Repo",
    });
    await assert.rejects(qualificationMain(["bootstrap", "C:\\evidence.json"]), {
      message: "Bootstrap qualification requires router-responses-v1 backend",
    });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(previous, key)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test("accepts only the fixed read-only bootstrap profile", () => {
  const current = identity();
  const bootstrap = {
    schemaVersion: 2,
    mode: "bootstrap",
    identity: current,
    approvedAt: "2026-09-13T00:00:00.000Z",
    checks: Object.fromEntries(REQUIRED_SCOPED_BOOTSTRAP_CHECKS.map((name) => [name, true])),
    bootstrap: SCOPED_BOOTSTRAP_PROFILE,
  };
  const fingerprint = requireScopedBootstrap(current, bootstrap);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(matchesScopedBootstrapRequest({
    scoped: true, access: "read-only", workspace: SCOPED_BOOTSTRAP_PROFILE.workspace,
    task: SCOPED_BOOTSTRAP_PROFILE.task,
    scope: { read: [...SCOPED_BOOTSTRAP_PROFILE.read], write: [], allow_create: false },
  }), true);
  assert.equal(matchesScopedBootstrapRequest({
    scoped: true, access: "workspace-write", workspace: SCOPED_BOOTSTRAP_PROFILE.workspace,
    task: SCOPED_BOOTSTRAP_PROFILE.task,
    scope: { read: [...SCOPED_BOOTSTRAP_PROFILE.read], write: [], allow_create: false },
  }), false);
  assert.throws(() => requireScopedBootstrap(current, {
    ...bootstrap,
    bootstrap: { ...SCOPED_BOOTSTRAP_PROFILE, task: "read anything" },
  }), { code: "app_server_incompatible" });
  assert.throws(() => requireScopedBootstrap(current, {
    ...bootstrap,
    checks: { ...bootstrap.checks, brokerReadWrite: false },
  }), { code: "app_server_incompatible" });
});
