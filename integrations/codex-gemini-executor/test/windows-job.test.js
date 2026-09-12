import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const helper = fileURLToPath(new URL("../src/app-server/windows-job.ps1", import.meta.url));
const parentFixture = fileURLToPath(new URL("./fixtures/windows-job-parent.cjs", import.meta.url));
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForStopped(pids) {
  const deadline = Date.now() + 5_000;
  while (pids.some(isRunning) && Date.now() < deadline) await delay(50);
  assert.deepEqual(pids.filter(isRunning), [], "owned processes must all exit");
}

test("Windows job closes the owned child tree when its parent disappears", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async (t) => {
  const argument = 'space and "quote" with trailing slash\\';
  const childScript = `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', windowsHide: true,
    });
    descendant.on('spawn', () => {
      process.stdout.write(JSON.stringify({ kind: 'ready', pid: process.pid,
        descendantPid: descendant.pid, argument: process.argv[1] }) + '\\n');
    });
    process.stdin.once('data', data => {
      process.stdout.write(JSON.stringify({ kind: 'input', value: data.toString() }) + '\\n');
    });
    setInterval(() => {}, 1000);
  `;
  const launchSpec = Buffer.from(JSON.stringify({
    executablePath: process.execPath,
    arguments: ["-e", childScript, "--", argument],
  })).toString("base64");
  // The parent is a static fixture file (no inline -e code): it launches the
  // job wrapper exactly the way src/app-server/process.js does.
  const parent = spawn(process.execPath, [parentFixture, powershell, helper, launchSpec], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ownedPids = [parent.pid];
  t.after(async () => {
    for (const pid of ownedPids) {
      if (isRunning(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
    parent.stdin.destroy();
    parent.stdout.destroy();
    parent.stderr.destroy();
  });
  let errors = "";
  parent.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const messages = [];
  const lines = createInterface({ input: parent.stdout });
  t.after(() => lines.close());
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { errors += `Unexpected helper stdout: ${line}`; return; }
    messages.push(message);
    if (message.kind === "wrapper") ownedPids.push(message.pid);
    if (message.kind === "ready") ownedPids.push(message.pid, message.descendantPid);
  });
  async function waitForMessage(kind) {
    const deadline = Date.now() + 10_000;
    while (!messages.some((message) => message.kind === kind) && Date.now() < deadline) {
      assert.equal(errors, "", "helper must not report an error");
      await delay(50);
    }
    const message = messages.find((entry) => entry.kind === kind);
    assert.ok(message, `expected ${kind} message; stderr: ${errors}`);
    return message;
  }

  const ready = await waitForMessage("ready");
  assert.equal(ready.argument, argument, "Windows quoting must preserve arguments");
  parent.stdin.write("stdio-check\n");
  assert.equal((await waitForMessage("input")).value, "stdio-check\n");
  assert.ok(isRunning(ready.pid));
  assert.ok(isRunning(ready.descendantPid));

  const parentExited = once(parent, "exit");
  parent.kill("SIGKILL");
  await parentExited;
  await waitForStopped(ownedPids);
  assert.equal(errors, "");
});

test("Windows job stops descendants before reporting the child's normal exit", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async (t) => {
  const childScript = `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', windowsHide: true,
    });
    descendant.on('spawn', () => {
      process.stdout.write(String(descendant.pid) + '\\n');
      process.exit(7);
    });
  `;
  const launchSpec = Buffer.from(JSON.stringify({
    executablePath: process.execPath,
    arguments: ["-e", childScript],
  })).toString("base64");
  const wrapper = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", helper,
    "-ParentPid", String(process.pid), "-LaunchSpecBase64", launchSpec], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  wrapper.stdout.on("data", (chunk) => { output += chunk.toString(); });
  wrapper.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  t.after(() => {
    for (const pid of [wrapper.pid, Number(output.trim())]) {
      if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
    wrapper.stdin.destroy();
    wrapper.stdout.destroy();
    wrapper.stderr.destroy();
  });
  const [exitCode] = await once(wrapper, "exit");
  assert.equal(exitCode, 7, errors);
  assert.equal(errors, "");
  const descendantPid = Number(output.trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  assert.equal(isRunning(descendantPid), false, "no descendant may outlive a successful wrapper exit");
});
