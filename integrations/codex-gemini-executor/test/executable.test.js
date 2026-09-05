import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import {
  AppServerExecutableError,
  observeConfiguredExecutable,
} from "../src/app-server/executable.js";

function options(overrides = {}) {
  return {
    executablePath: "C:\\CodexDesktop\\codex.exe",
    allowedExecutableRoot: "C:\\CodexDesktop",
    realpathPath: async (value) => value,
    statPath: async () => ({ isFile: () => true }),
    createInputStream: () => Readable.from([Buffer.from("binary")]),
    readVersion: async (value) => {
      assert.equal(value, "C:\\CodexDesktop\\codex.exe");
      return "codex-cli 0.153.4";
    },
    ...overrides,
  };
}

test("observes the exact configured executable", async () => {
  const observation = await observeConfiguredExecutable(options());
  assert.equal(observation.executablePath, "C:\\CodexDesktop\\codex.exe");
  assert.equal(observation.version, "codex-cli 0.153.4");
  assert.match(observation.executableSha256, /^[a-f0-9]{64}$/);
});

test("rejects relative and canonically escaped executable paths", async () => {
  await assert.rejects(
    observeConfiguredExecutable(options({ executablePath: "codex.exe" })),
    { code: "app_server_executable_error", details: { reason: "path_not_absolute", stage: "validate" } },
  );
  await assert.rejects(
    observeConfiguredExecutable(options({
      realpathPath: async (value) => value.endsWith("codex.exe")
        ? "C:\\CodexDesktop-old\\codex.exe"
        : value,
    })),
    { code: "app_server_executable_error", details: { reason: "path_outside_allowed_root", stage: "canonicalize" } },
  );
});

test("rejects a directory and invalid version output", async () => {
  await assert.rejects(
    observeConfiguredExecutable(options({ statPath: async () => ({ isFile: () => false }) })),
    { code: "app_server_executable_error", details: { reason: "not_a_file", stage: "stat" } },
  );
  await assert.rejects(
    observeConfiguredExecutable(options({ readVersion: async () => "   " })),
    { code: "app_server_executable_error", details: { reason: "invalid_version", stage: "version" } },
  );
  await assert.rejects(
    observeConfiguredExecutable(options({ readVersion: async () => "v".repeat(4097) })),
    { code: "app_server_executable_error", details: { reason: "version_too_large", stage: "version" } },
  );
});

test("sanitizes stream failures", async () => {
  const brokenStream = new Readable({
    read() {
      this.destroy(new Error("sensitive stream path"));
    },
  });
  await assert.rejects(observeConfiguredExecutable(options({ createInputStream: () => brokenStream })), (error) => {
    assert.ok(error instanceof AppServerExecutableError);
    assert.equal(error.details.reason, "hash_failed");
    assert.equal(error.details.stage, "hash");
    assert.equal(error.details.causeType, "Error");
    assert.equal(JSON.stringify(error).includes("sensitive stream path"), false);
    return true;
  });
});
