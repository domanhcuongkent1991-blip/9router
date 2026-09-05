# Codex Gemini Compatibility Adapter Phase 1 Implementation Plan

> **For agent 2:** Execute this plan task-by-task in the existing agent 2 chat. Do not create subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline, capability-first App Server compatibility boundary and prove that incompatible App Server behavior fails before any workspace mutation.

**Architecture:** Add a dependency-free Node package under `integrations/codex-gemini-executor`. A thin adapter observes version/hash for diagnostics, performs an injected handshake and capability probe, and returns one normalized compatibility result. Version changes warn but do not block; missing required behavior throws `app_server_incompatible`. A separate startup coordinator calls the adapter before acquiring a workspace lease.

**Tech Stack:** Node.js ES modules, built-in `node:test`, built-in `node:assert`, no downloaded dependencies, no live App Server, no 9Router provider calls.

---

## Scope and ownership

Agent 2 owns only:

```text
integrations/codex-gemini-executor/**
```

Do not modify root `package.json`, root lockfiles, `open-sse/**`, Codex Desktop files, plugin state, `config.toml`, user workspaces, or provider configuration. Do not install packages. Do not push, merge, deploy, or call a live Gemini provider.

## File map

```text
integrations/codex-gemini-executor/package.json
    Dependency-free package metadata and bounded test commands.

integrations/codex-gemini-executor/src/app-server/compatibility.js
    Required stable capability list, capability-first decision policy,
    normalized warnings, and typed incompatibility error.

integrations/codex-gemini-executor/src/app-server/adapter.js
    Injected observation, initialize handshake, and read-only probe orchestration.

integrations/codex-gemini-executor/src/startup.js
    Enforces compatibility success before acquiring a workspace lease.

integrations/codex-gemini-executor/test/compatibility.test.js
    Pure policy contract tests.

integrations/codex-gemini-executor/test/adapter.test.js
    Adapter call order and stable-handshake tests with fakes.

integrations/codex-gemini-executor/test/startup.test.js
    Fail-closed ordering tests proving no workspace mutation on incompatibility.
```

### Task 1: Create the dependency-free package boundary

**Files:**
- Create: `integrations/codex-gemini-executor/package.json`

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@9router/codex-gemini-executor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test --test-concurrency=2",
    "test:adapter": "node --test --test-concurrency=2 test/compatibility.test.js test/adapter.test.js test/startup.test.js"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Verify the package metadata without installing anything**

Run:

```powershell
node -e "const p=require('./integrations/codex-gemini-executor/package.json'); if(p.private!==true||p.dependencies||p.devDependencies) process.exit(1)"
```

Expected: exit code `0` and no output.

- [ ] **Step 3: Commit only the manifest**

```powershell
git add -- integrations/codex-gemini-executor/package.json
git diff --cached --check
git commit -m "chore: scaffold Gemini executor companion"
```

### Task 2: Define the capability-first compatibility policy

**Files:**
- Create: `integrations/codex-gemini-executor/test/compatibility.test.js`
- Create: `integrations/codex-gemini-executor/src/app-server/compatibility.js`

- [ ] **Step 1: Write the failing policy tests**

Create `test/compatibility.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  APP_SERVER_REQUIRED_METHODS,
  AppServerCompatibilityError,
  assessAppServerCompatibility,
} from "../src/app-server/compatibility.js";

function compatibleInput(overrides = {}) {
  return {
    observation: {
      version: "1.2.0",
      executableSha256: "a".repeat(64),
    },
    baseline: {
      version: "1.1.0",
      executableSha256: "b".repeat(64),
    },
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

  assert.throws(
    () => assessAppServerCompatibility(input),
    (error) => {
      assert.ok(error instanceof AppServerCompatibilityError);
      assert.equal(error.code, "app_server_incompatible");
      assert.equal(error.userMessage, "Codex version chưa được hỗ trợ");
      assert.deepEqual(error.details.missingCapabilities, ["turn/interrupt"]);
      return true;
    },
  );
});

test("fails closed on an invalid handshake or schema subset", () => {
  assert.throws(
    () => assessAppServerCompatibility(compatibleInput({ handshake: { ok: false } })),
    AppServerCompatibilityError,
  );
  assert.throws(
    () => assessAppServerCompatibility(compatibleInput({ schemaSubsetCompatible: false })),
    AppServerCompatibilityError,
  );
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```powershell
npm --prefix integrations/codex-gemini-executor run test:adapter
```

Expected: failure because `src/app-server/compatibility.js` does not exist.

- [ ] **Step 3: Implement the minimal policy**

Create `src/app-server/compatibility.js`:

```js
export const APP_SERVER_REQUIRED_METHODS = Object.freeze([
  "model/list",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
]);

export class AppServerCompatibilityError extends Error {
  constructor(details) {
    super("Codex version chưa được hỗ trợ");
    this.name = "AppServerCompatibilityError";
    this.code = "app_server_incompatible";
    this.userMessage = "Codex version chưa được hỗ trợ";
    this.details = details;
  }
}

function incompatibility(details) {
  throw new AppServerCompatibilityError(details);
}

export function assessAppServerCompatibility({
  observation,
  baseline,
  handshake,
  schemaSubsetCompatible,
  methods,
}) {
  const missingCapabilities = APP_SERVER_REQUIRED_METHODS.filter(
    (name) => methods?.[name] !== true,
  );

  if (handshake?.ok !== true || schemaSubsetCompatible !== true || missingCapabilities.length > 0) {
    incompatibility({
      observedVersion: observation?.version ?? "unknown",
      handshakeCompatible: handshake?.ok === true,
      schemaSubsetCompatible: schemaSubsetCompatible === true,
      missingCapabilities,
    });
  }

  const warnings = [];
  if (baseline?.version && baseline.version !== observation?.version) {
    warnings.push({
      code: "codex_version_changed",
      previous: baseline.version,
      observed: observation?.version ?? "unknown",
    });
  }
  if (
    baseline?.executableSha256
    && baseline.executableSha256 !== observation?.executableSha256
  ) {
    warnings.push({ code: "codex_executable_changed" });
  }

  return {
    status: "compatible",
    warnings,
    diagnostics: {
      observedVersion: observation?.version ?? "unknown",
      executableChanged: warnings.some(
        (warning) => warning.code === "codex_executable_changed",
      ),
    },
  };
}
```

- [ ] **Step 4: Run the policy tests and confirm GREEN**

Run:

```powershell
node --test integrations/codex-gemini-executor/test/compatibility.test.js
```

Expected: `3` tests pass and `0` fail.

- [ ] **Step 5: Commit the policy and tests**

```powershell
git add -- integrations/codex-gemini-executor/src/app-server/compatibility.js integrations/codex-gemini-executor/test/compatibility.test.js
git diff --cached --check
git commit -m "feat: define App Server compatibility policy"
```

### Task 3: Add the thin adapter orchestration

**Files:**
- Create: `integrations/codex-gemini-executor/test/adapter.test.js`
- Create: `integrations/codex-gemini-executor/src/app-server/adapter.js`

- [ ] **Step 1: Write the failing adapter tests**

Create `test/adapter.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import { createAppServerCompatibilityAdapter } from "../src/app-server/adapter.js";

test("runs observation, stable handshake, and read-only probes in order", async () => {
  const calls = [];
  const warnings = [];
  const methods = Object.fromEntries(APP_SERVER_REQUIRED_METHODS.map((name) => [name, true]));

  const adapter = createAppServerCompatibilityAdapter({
    baseline: { version: "1.1.0", executableSha256: "b".repeat(64) },
    clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
    observeExecutable: async () => {
      calls.push("observe");
      return { version: "1.2.0", executableSha256: "a".repeat(64) };
    },
    initialize: async (request) => {
      calls.push("initialize");
      assert.equal(request.capabilities.experimentalApi, false);
      return { ok: true };
    },
    probeRequiredContract: async () => {
      calls.push("probe");
      return { schemaSubsetCompatible: true, methods };
    },
    onWarning: (warning) => warnings.push(warning.code),
  });

  const result = await adapter.check();

  assert.equal(result.status, "compatible");
  assert.deepEqual(calls, ["observe", "initialize", "probe"]);
  assert.deepEqual(warnings, ["codex_version_changed", "codex_executable_changed"]);
});

test("does not retry or switch executables after an incompatible probe", async () => {
  let probeCalls = 0;
  const methods = Object.fromEntries(APP_SERVER_REQUIRED_METHODS.map((name) => [name, true]));
  methods["thread/start"] = false;

  const adapter = createAppServerCompatibilityAdapter({
    baseline: { version: "1.2.0", executableSha256: "a".repeat(64) },
    clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
    observeExecutable: async () => ({ version: "1.2.0", executableSha256: "a".repeat(64) }),
    initialize: async () => ({ ok: true }),
    probeRequiredContract: async () => {
      probeCalls += 1;
      return { schemaSubsetCompatible: true, methods };
    },
  });

  await assert.rejects(() => adapter.check(), { code: "app_server_incompatible" });
  assert.equal(probeCalls, 1);
});

test("normalizes transport failures without exposing their message", async () => {
  const adapter = createAppServerCompatibilityAdapter({
    baseline: { version: "1.2.0", executableSha256: "a".repeat(64) },
    clientInfo: { name: "nine_router_gemini", title: "9Router Gemini", version: "0.1.0" },
    observeExecutable: async () => ({ version: "1.2.0", executableSha256: "a".repeat(64) }),
    initialize: async () => { throw new Error("credential-like transport detail"); },
    probeRequiredContract: async () => { throw new Error("must not run"); },
  });

  await assert.rejects(
    () => adapter.check(),
    (error) => {
      assert.equal(error.code, "app_server_incompatible");
      assert.equal(error.userMessage, "Codex version chưa được hỗ trợ");
      assert.equal(error.details.stage, "initialize");
      assert.equal(JSON.stringify(error.details).includes("credential-like"), false);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run the adapter test and confirm RED**

Run:

```powershell
node --test integrations/codex-gemini-executor/test/adapter.test.js
```

Expected: failure because `src/app-server/adapter.js` does not exist.

- [ ] **Step 3: Implement the injected adapter**

Create `src/app-server/adapter.js`:

```js
import {
  AppServerCompatibilityError,
  assessAppServerCompatibility,
} from "./compatibility.js";

function normalizeFailure(error, stage, observedVersion = "unknown") {
  if (error instanceof AppServerCompatibilityError) {
    return error;
  }
  return new AppServerCompatibilityError({
    observedVersion,
    stage,
    causeType: error instanceof Error ? error.name : "UnknownError",
  });
}

export function createAppServerCompatibilityAdapter({
  baseline,
  clientInfo,
  observeExecutable,
  initialize,
  probeRequiredContract,
  onWarning = () => {},
}) {
  return Object.freeze({
    async check() {
      let stage = "observe";
      let observation;
      try {
        observation = await observeExecutable();
        stage = "initialize";
        const handshake = await initialize({
          clientInfo,
          capabilities: { experimentalApi: false },
        });
        stage = "probe";
        const probe = await probeRequiredContract();
        const result = assessAppServerCompatibility({
          observation,
          baseline,
          handshake,
          schemaSubsetCompatible: probe.schemaSubsetCompatible,
          methods: probe.methods,
        });

        for (const warning of result.warnings) {
          onWarning(warning);
        }
        return result;
      } catch (error) {
        throw normalizeFailure(error, stage, observation?.version);
      }
    },
  });
}
```

- [ ] **Step 4: Run adapter tests and confirm GREEN**

Run:

```powershell
node --test integrations/codex-gemini-executor/test/compatibility.test.js integrations/codex-gemini-executor/test/adapter.test.js
```

Expected: `6` tests pass and `0` fail.

- [ ] **Step 5: Commit the adapter**

```powershell
git add -- integrations/codex-gemini-executor/src/app-server/adapter.js integrations/codex-gemini-executor/test/adapter.test.js
git diff --cached --check
git commit -m "feat: add capability-first App Server adapter"
```

### Task 4: Enforce fail-closed startup ordering

**Files:**
- Create: `integrations/codex-gemini-executor/test/startup.test.js`
- Create: `integrations/codex-gemini-executor/src/startup.js`

- [ ] **Step 1: Write the failing startup-order tests**

Create `test/startup.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { prepareGeminiJob } from "../src/startup.js";

test("checks compatibility before acquiring a workspace lease", async () => {
  const calls = [];
  const result = await prepareGeminiJob({
    request: { task: "inspect", workspace: "D:\\fixture" },
    validateRequest: async (request) => {
      calls.push("validate");
      return request;
    },
    compatibilityAdapter: {
      check: async () => {
        calls.push("compatibility");
        return { status: "compatible", warnings: [] };
      },
    },
    acquireWorkspaceLease: async () => {
      calls.push("workspace");
      return { release: async () => {} };
    },
  });

  assert.deepEqual(calls, ["validate", "compatibility", "workspace"]);
  assert.equal(result.compatibility.status, "compatible");
});

test("leaves the workspace untouched when compatibility fails", async () => {
  let workspaceCalls = 0;
  const incompatibility = Object.assign(new Error("unsupported"), {
    code: "app_server_incompatible",
  });

  await assert.rejects(
    () => prepareGeminiJob({
      request: { task: "inspect", workspace: "D:\\fixture" },
      validateRequest: async (request) => request,
      compatibilityAdapter: { check: async () => { throw incompatibility; } },
      acquireWorkspaceLease: async () => {
        workspaceCalls += 1;
        return { release: async () => {} };
      },
    }),
    { code: "app_server_incompatible" },
  );

  assert.equal(workspaceCalls, 0);
});
```

- [ ] **Step 2: Run the startup test and confirm RED**

Run:

```powershell
node --test integrations/codex-gemini-executor/test/startup.test.js
```

Expected: failure because `src/startup.js` does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Create `src/startup.js`:

```js
export async function prepareGeminiJob({
  request,
  validateRequest,
  compatibilityAdapter,
  acquireWorkspaceLease,
}) {
  const validatedRequest = await validateRequest(request);
  const compatibility = await compatibilityAdapter.check();
  const workspaceLease = await acquireWorkspaceLease(validatedRequest);

  return Object.freeze({
    request: validatedRequest,
    compatibility,
    workspaceLease,
  });
}
```

- [ ] **Step 4: Run all Phase 1 adapter tests and confirm GREEN**

Run:

```powershell
npm --prefix integrations/codex-gemini-executor run test:adapter
```

Expected: `8` tests pass and `0` fail.

- [ ] **Step 5: Commit the startup gate**

```powershell
git add -- integrations/codex-gemini-executor/src/startup.js integrations/codex-gemini-executor/test/startup.test.js
git diff --cached --check
git commit -m "feat: gate Gemini jobs on App Server compatibility"
```

### Task 5: Final offline verification and handoff

**Files:**
- Verify only: `integrations/codex-gemini-executor/**`

- [ ] **Step 1: Run the complete package test suite**

```powershell
npm --prefix integrations/codex-gemini-executor test
```

Expected: `8` tests pass and `0` fail.

- [ ] **Step 2: Verify formatting and scope**

```powershell
git diff --check
git status --short
git log -4 --oneline
```

Expected:

- no whitespace errors;
- no staged files;
- only pre-existing unrelated root files remain dirty;
- the four Phase 1 commits appear at the top of the branch.

- [ ] **Step 3: Run the available staged secret scan before each commit**

If `gitleaks` is already installed, run this after staging and before each commit:

```powershell
gitleaks git --staged --redact --no-banner --no-color
```

Expected: exit code `0` and no leaks. Do not install a scanner if it is missing; report security coverage as `limited`. This package adds no dependencies, so do not create a lockfile or run an online dependency scan.

- [ ] **Step 4: Report the exact handoff**

Report:

- commit hashes and exact files per commit;
- test command and pass/fail counts;
- confirmation that version/hash changes warn but do not block;
- confirmation that missing required capability prevents workspace acquisition;
- confirmation that no dependency was installed and no Desktop, provider, root runtime, workspace, push, merge, or deployment action occurred;
- any unresolved evidence as a limitation rather than a pass.
