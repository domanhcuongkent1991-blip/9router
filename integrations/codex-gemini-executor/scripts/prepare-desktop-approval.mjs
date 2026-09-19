#!/usr/bin/env node
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectBootstrapCandidate, APP_SERVER } from "./bootstrap-switch-plan.mjs";
import { BEFORE, CASES, requestFor, sha, check, verifyHarness, verifyFixture } from "./desktop-approval-canary.mjs";

export async function prepareDesktopApproval(candidatePath) {
  // All existing gates must pass before provisioning this narrow harness.
  await inspectBootstrapCandidate(candidatePath);
  const candidate = JSON.parse(await readFile(win32.join(candidatePath, "candidate.json"), "utf8"));
  const id = randomUUID();
  const root = win32.join("C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime\\approval-canaries", id);
  const fixtureRoot = win32.join("C:\\tmp\\CodexScratch", "nine-router-approval-" + id);
  const hostHash = sha(await readFile(APP_SERVER));
  const version = execFileSync(APP_SERVER, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  check(/^codex-cli [A-Za-z0-9.+-]+$/.test(version) && hostHash === sha(await readFile(APP_SERVER)), "host_changed");
  await mkdir(root, { recursive: true });
  await mkdir(fixtureRoot); // never reuse a previous fixture
  for (const base of [fixtureRoot, win32.join(fixtureRoot, "scripted")]) {
    for (const scenario of CASES) {
      const r = requestFor(base, scenario);
      await mkdir(r.workspace, { recursive: true });
      await writeFile(win32.join(r.workspace, "canary-input.txt"), BEFORE, { flag: "wx" });
      await verifyFixture(base, scenario);
    }
  }
  const scripts = fileURLToPath(new URL(".", import.meta.url));
  const artifacts = {};
  for (const name of ["desktop-approval-canary.mjs", "Set-DesktopApprovalCanarySafe.ps1", "Set-NineRouterBootstrapSafe.ps1"]) {
    const bytes = await readFile(win32.join(scripts, name));
    await writeFile(win32.join(root, name), bytes, { flag: "wx" });
    artifacts[name] = sha(bytes);
    await chmod(win32.join(root, name), 0o444);
  }
  const descriptor = { schemaVersion: 1, root, fixtureRoot, candidatePath, identity: candidate.identity, release: candidate.release,
    host: { path: APP_SERVER, version, sha256: hostHash }, artifacts };
  const descriptorPath = win32.join(root, "canary.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor, null, 2), { flag: "wx" });
  await chmod(descriptorPath, 0o444);
  await verifyHarness(descriptorPath);
  const requests = Object.fromEntries(CASES.map((c) => [c, requestFor(fixtureRoot, c)]));
  await writeFile(win32.join(root, "requests.json"), JSON.stringify(requests, null, 2), { flag: "wx" });
  return { status: "prepared", descriptorPath, root, fixtureRoot, release: candidate.release, host: descriptor.host, readiness: "HOLD" };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  prepareDesktopApproval(process.argv[2]).then((r) => process.stdout.write(JSON.stringify(r) + "\n"))
    .catch(() => { process.stderr.write("Canary preparation failed; retain artifacts\n"); process.exitCode = 1; });
}
