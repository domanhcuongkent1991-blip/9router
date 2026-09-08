import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { win32 } from "node:path";

import {
  AppServerProcessError,
  generateStableSchemaBundle,
  launchAppServer,
  readExecutableVersion,
  stopChildProcess,
} from "../src/app-server/process.js";

function fakeChild({ killExits = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal ?? "default");
    if (killExits) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, signal ?? null));
    }
    return true;
  };
  return child;
}

test("launches the exact executable with isolated options", () => {
  const child = fakeChild();
  const calls = [];
  const environment = { PATH: "fixed", CODEX_HOME: "old" };
  const result = launchAppServer({
    executablePath: "C:\\CodexDesktop\\codex.exe",
    codexHome: "C:\\IsolatedCodexHome",
    workingDirectory: "D:\\Workspace",
    platform: "linux",
    environment,
    spawnProcess: (...args) => { calls.push(args); return child; },
  });
  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "C:\\CodexDesktop\\codex.exe",
    ["app-server", "--listen", "stdio://"],
    {
      cwd: "D:\\Workspace",
      env: { PATH: "fixed", CODEX_HOME: "C:\\IsolatedCodexHome" },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ]);
  assert.deepEqual(environment, { PATH: "fixed", CODEX_HOME: "old" });
});

test("Windows launch uses the owned job helper with a fixed app-server payload", () => {
  const child = fakeChild();
  const calls = [];
  const result = launchAppServer({
    executablePath: "C:\\CodexDesktop\\codex.exe",
    codexHome: "C:\\IsolatedCodexHome",
    workingDirectory: "D:\\Workspace",
    environment: { PATH: "fixed" },
    platform: "win32",
    spawnProcess: (...args) => { calls.push(args); return child; },
  });
  assert.equal(result, child);
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.deepEqual(args.slice(0, 9), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("../src/app-server/windows-job.ps1", import.meta.url)),
    "-ParentPid", String(process.pid),
  ]);
  assert.equal(args[9], "-LaunchSpecBase64");
  assert.deepEqual(JSON.parse(Buffer.from(args[10], "base64").toString("utf8")), {
    executablePath: "C:\\CodexDesktop\\codex.exe",
    arguments: ["app-server", "--listen", "stdio://"],
  });
  assert.deepEqual(options, {
    cwd: "D:\\Workspace",
    env: { PATH: "fixed", CODEX_HOME: "C:\\IsolatedCodexHome" },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
});

test("rejects relative launch paths before spawn", () => {
  for (const override of [
    { executablePath: "codex.exe" },
    { workingDirectory: "workspace" },
    { codexHome: "isolated" },
  ]) {
    let spawned = false;
    assert.throws(() => launchAppServer({
      executablePath: "C:\\CodexDesktop\\codex.exe",
      codexHome: "C:\\IsolatedCodexHome",
      workingDirectory: "D:\\Workspace",
      environment: {},
      spawnProcess: () => { spawned = true; },
      ...override,
    }), { code: "app_server_process_error" });
    assert.equal(spawned, false);
  }
});

test("reads bounded version output only after successful exit", async () => {
  const child = fakeChild();
  const calls = [];
  const promise = readExecutableVersion({
    executablePath: "C:\\CodexDesktop\\codex.exe",
    spawnProcess: (...args) => { calls.push(args); return child; },
  });
  child.stdout.write(" codex-cli 0.153.4 \n");
  child.stderr.write("ignored diagnostic");
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  assert.equal(await promise, "codex-cli 0.153.4");
  assert.deepEqual(calls[0][0], "C:\\CodexDesktop\\codex.exe");
  assert.deepEqual(calls[0][1], ["--version"]);
  assert.equal(calls[0][2].shell, false);
});

test("waits for close so stdout emitted after exit is included", async () => {
  const child = fakeChild();
  const pending = readExecutableVersion({
    executablePath: "C:\\CodexDesktop\\codex.exe",
    spawnProcess: () => child,
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.write("codex-cli delayed\n");
  child.emit("close", 0, null);
  assert.equal(await pending, "codex-cli delayed");
});

test("fails version reads on timeout, nonzero, empty, or oversized output", async () => {
  const cases = [
    { reason: "timeout", run: (child) => readExecutableVersion({ executablePath: "C:\\CodexDesktop\\codex.exe", spawnProcess: () => child, timeoutMs: 5 }) },
    { reason: "nonzero_exit", run: (child) => { const result = readExecutableVersion({ executablePath: "C:\\CodexDesktop\\codex.exe", spawnProcess: () => child }); child.exitCode = 2; child.emit("exit", 2, null); child.emit("close", 2, null); return result; } },
    { reason: "empty_output", run: (child) => { const result = readExecutableVersion({ executablePath: "C:\\CodexDesktop\\codex.exe", spawnProcess: () => child }); child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); return result; } },
    { reason: "stdout_too_large", run: (child) => { const result = readExecutableVersion({ executablePath: "C:\\CodexDesktop\\codex.exe", spawnProcess: () => child }); child.stdout.write("secret".repeat(700)); return result; } },
  ];
  for (const entry of cases) {
    const child = fakeChild();
    await assert.rejects(entry.run(child), (error) => {
      assert.ok(error instanceof AppServerProcessError);
      assert.equal(error.details.reason, entry.reason);
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    });
  }
});

test("generates only the stable schema bundle with exact arguments", async () => {
  const child = fakeChild();
  const calls = [];
  const promise = generateStableSchemaBundle({
    executablePath: "C:\\CodexDesktop\\codex.exe",
    outputDirectory: "C:\\SchemaOutput",
    spawnProcess: (...args) => { calls.push(args); return child; },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  assert.deepEqual(await promise, { ok: true });
  assert.deepEqual(calls[0][1], ["app-server", "generate-json-schema", "--out", "C:\\SchemaOutput"]);
  assert.equal(calls[0][1].includes("--experimental"), false);

  for (const mode of ["timeout", "nonzero"]) {
    const failedChild = fakeChild();
    const failed = generateStableSchemaBundle({
      executablePath: "C:\\CodexDesktop\\codex.exe",
      outputDirectory: "C:\\SchemaOutput",
      spawnProcess: () => failedChild,
      timeoutMs: 5,
    });
    if (mode === "nonzero") {
      failedChild.exitCode = 1;
      failedChild.emit("exit", 1, null);
      failedChild.emit("close", 1, null);
    }
    await assert.rejects(failed, { code: "app_server_process_error" });
  }
});

test("stops children idempotently and escalates at most once", async () => {
  const exited = fakeChild();
  exited.exitCode = 0;
  await stopChildProcess(exited, { graceMs: 5 });
  assert.deepEqual(exited.kills, []);

  const normal = fakeChild();
  await Promise.all([
    stopChildProcess(normal, { graceMs: 20 }),
    stopChildProcess(normal, { graceMs: 20 }),
  ]);
  assert.deepEqual(normal.kills, ["default"]);

  const stubborn = fakeChild({ killExits: false });
  const stopping = stopChildProcess(stubborn, { graceMs: 5 });
  setTimeout(() => {
    stubborn.exitCode = 0;
    stubborn.emit("exit", 0, "SIGKILL");
  }, 7);
  await stopping;
  assert.deepEqual(stubborn.kills, ["default", "SIGKILL"]);
});

test("rejects concurrent stop waiters after a bounded post-force deadline", async () => {
  const child = fakeChild({ killExits: false });
  const first = stopChildProcess(child, { graceMs: 1 });
  const second = stopChildProcess(child, { graceMs: 1 });
  let safetyTimer;
  const safetyDeadline = new Promise((resolve) => {
    safetyTimer = setTimeout(() => resolve("still-pending"), 40);
  });
  const outcome = await Promise.race([Promise.allSettled([first, second]), safetyDeadline]);
  clearTimeout(safetyTimer);

  assert.notEqual(outcome, "still-pending");
  assert.equal(outcome.length, 2);
  for (const result of outcome) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof AppServerProcessError);
    assert.deepEqual(result.reason.details, { reason: "termination_timeout", stage: "stop" });
  }
  assert.deepEqual(child.kills, ["default", "SIGKILL"]);
  assert.equal(child.listenerCount("exit"), 0);
});

function containedChild() {
  const child = fakeChild();
  return launchAppServer({
    executablePath: "C:\\CodexDesktop\\codex.exe",
    codexHome: "C:\\IsolatedCodexHome",
    workingDirectory: "D:\\Workspace",
    environment: {},
    platform: "win32",
    spawnProcess: () => child,
  });
}

test("contained shutdown closes stdin and waits for the wrapper's cooperative exit", async () => {
  const child = containedChild();
  let resolved = false;
  const stopping = stopChildProcess(child, { graceMs: 100 }).then(() => { resolved = true; });
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await stopping;
  await stopChildProcess(child);
  assert.equal(resolved, true);
});

test("forced contained shutdown stays unconfirmed for all later stop waiters", async () => {
  const child = containedChild();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const outcomes = await Promise.allSettled([
      stopChildProcess(child, { graceMs: 5 }),
      stopChildProcess(child, { graceMs: 5 }),
    ]);
    assert.deepEqual(child.kills, ["SIGKILL"]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected");
      assert.deepEqual(outcome.reason.details, { reason: "termination_unconfirmed", stage: "stop" });
    }
    await assert.rejects(stopChildProcess(child), (error) => error.details.reason === "termination_unconfirmed");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a contained helper failure exit is never treated as confirmed shutdown", async () => {
  const child = containedChild();
  child.exitCode = 125;
  await assert.rejects(stopChildProcess(child), (error) => error.details.reason === "termination_unconfirmed");
});
