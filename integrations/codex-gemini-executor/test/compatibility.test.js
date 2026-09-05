import test from "node:test";
import assert from "node:assert/strict";

import {
  APP_SERVER_REQUIRED_METHODS,
  AppServerCompatibilityError,
  assessAppServerCompatibility,
} from "../src/app-server/compatibility.js";

function compatibleInput(overrides = {}) {
  return {
    observation: { version: "1.2.0", executableSha256: "a".repeat(64) },
    baseline: { version: "1.1.0", executableSha256: "b".repeat(64) },
    handshake: { ok: true },
    schemaSubsetCompatible: true,
    methods: Object.fromEntries(APP_SERVER_REQUIRED_METHODS.map((name) => [name, true])),
    ...overrides,
  };
}

test("allows a new Codex version when required capabilities still pass", () => {
  const result = assessAppServerCompatibility(compatibleInput());
  assert.equal(result.status, "compatible");
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    "codex_version_changed",
    "codex_executable_changed",
  ]);
  assert.equal(result.diagnostics.observedVersion, "1.2.0");
});

test("fails closed when a required stable method is missing", () => {
  const input = compatibleInput();
  input.methods["turn/interrupt"] = false;
  assert.throws(() => assessAppServerCompatibility(input), (error) => {
    assert.ok(error instanceof AppServerCompatibilityError);
    assert.equal(error.code, "app_server_incompatible");
    assert.equal(error.userMessage, "Codex version chưa được hỗ trợ");
    assert.deepEqual(error.details.missingCapabilities, ["turn/interrupt"]);
    return true;
  });
});

test("fails closed on an invalid handshake or schema subset", () => {
  assert.throws(() => assessAppServerCompatibility(compatibleInput({ handshake: { ok: false } })), AppServerCompatibilityError);
  assert.throws(() => assessAppServerCompatibility(compatibleInput({ schemaSubsetCompatible: false })), AppServerCompatibilityError);
});
