import test from "node:test";
import assert from "node:assert/strict";

import { readInstallationConfig } from "../src/installation.js";

function environment(overrides = {}) {
  return {
    NINEROUTER_CODEX_APP_SERVER_PATH: "C:\\CodexDesktop\\codex.exe",
    NINEROUTER_CODEX_APP_SERVER_ROOT: "C:\\CodexDesktop",
    NINEROUTER_CODEX_BASELINE_VERSION: "codex-cli 1.0.0",
    NINEROUTER_CODEX_BASELINE_SHA256: "a".repeat(64),
    NINEROUTER_GEMINI_MODEL: "gemini-fixed",
    NINEROUTER_API_KEY: "SECRET",
    NINEROUTER_PERMITTED_WORKSPACES: "D:\\Repo;D:\\Other",
    ...overrides,
  };
}

test("loads only installation-owned routing and workspace settings", () => {
  const config = readInstallationConfig(environment());
  assert.equal(config.executablePath, "C:\\CodexDesktop\\codex.exe");
  assert.equal(config.fixedModel, "gemini-fixed");
  assert.deepEqual(config.permittedWorkspaceRoots, ["D:\\Repo", "D:\\Other"]);
  assert.equal(config.baseline.executableSha256, "a".repeat(64));
});

test("rejects missing, relative, or injectable installation values", () => {
  for (const overrides of [
    { NINEROUTER_CODEX_APP_SERVER_PATH: "codex.exe" },
    { NINEROUTER_CODEX_BASELINE_SHA256: "bad" },
    { NINEROUTER_GEMINI_MODEL: "bad\nmodel" },
    { NINEROUTER_PERMITTED_WORKSPACES: "relative" },
  ]) assert.throws(() => readInstallationConfig(environment(overrides)), { code: "invalid_installation_configuration" });
});

test("entrypoint import does not start stdio", async () => {
  const entry = await import("../src/index.js");
  assert.equal(typeof entry.main, "function");
});
