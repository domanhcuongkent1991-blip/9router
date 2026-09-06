# Codex Schema Bundle Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Gemini companion qualify the canonical Codex App Server schema bundle regardless of the number of split schema files emitted beside it.

**Architecture:** Keep the change inside `installation.js`: select one fixed canonical filename, preserve the 4 MiB/JSON/required-definition fail-closed checks, and feed the same parsed bundle to stable and approval qualification. Add focused loader contract coverage in `installation.test.js`; do not change executor, MCP, workspace, provider, or dependency boundaries.

**Tech Stack:** Node.js 20+ ESM, `node:test`, existing App Server schema qualifiers, Git, Gitleaks, Codex Desktop App Server CLI.

---

### Task 1: Expose the existing loader as an internal compatibility seam

**Files:**
- Modify: `integrations/codex-gemini-executor/test/installation.test.js`
- Modify: `integrations/codex-gemini-executor/src/installation.js`

- [ ] **Step 1: Write the failing export contract test**

Replace the named installation import with a namespace import and add this test:

```js
import * as installation from "../src/installation.js";

const { readInstallationConfig } = installation;

test("exposes the generated schema loader as a focused compatibility seam", () => {
  assert.equal(typeof installation.readGeneratedSchemas, "function");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/installation.test.js
```

Expected: one assertion failure because `installation.readGeneratedSchemas` is
`undefined`; the existing installation tests still pass.

- [ ] **Step 3: Export the existing function without changing behavior**

Change only the declaration:

```js
export async function readGeneratedSchemas(
  directory,
  { readDirectory = readdir, readSchemaFile = readFile } = {},
) {
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test test/installation.test.js
```

Expected: all installation tests pass.

### Task 2: Reproduce and fix the split-schema count rejection

**Files:**
- Modify: `integrations/codex-gemini-executor/test/installation.test.js`
- Modify: `integrations/codex-gemini-executor/src/installation.js`

- [ ] **Step 1: Add a valid synthetic canonical bundle fixture**

Add these test-only helpers to `installation.test.js`:

```js
function objectSchema(properties, required = []) {
  return { type: "object", properties, required };
}

function envelope(method, paramsRef, { request = true } = {}) {
  return {
    type: "object",
    required: request ? ["id", "method", "params"] : ["method", "params"],
    properties: {
      ...(request ? { id: { $ref: "#/definitions/RequestId" } } : {}),
      method: { type: "string", enum: [method] },
      params: { $ref: paramsRef },
    },
  };
}

function canonicalSchemaBundle() {
  const definitions = {
    RequestId: { oneOf: [{ type: "integer" }, { type: "string" }] },
    InitializeParams: objectSchema({ clientInfo: { type: "object" }, capabilities: { type: "object" } }, ["clientInfo"]),
    ModelListParams: objectSchema({ limit: { type: "integer" }, includeHidden: { type: "boolean" } }),
    ThreadStartParams: objectSchema({ cwd: { type: "string" }, model: { type: "string" }, modelProvider: { type: "string" }, sandbox: { type: "string" }, approvalPolicy: { type: "string" }, ephemeral: { type: "boolean" } }),
    ThreadResumeParams: objectSchema({ threadId: { type: "string" }, cwd: { type: "string" }, model: { type: "string" }, modelProvider: { type: "string" }, sandbox: { type: "string" }, approvalPolicy: { type: "string" } }, ["threadId"]),
    TurnStartParams: objectSchema({ threadId: { type: "string" }, input: { type: "array" }, model: { type: "string" }, effort: { type: "string" } }, ["threadId", "input"]),
    TurnInterruptParams: objectSchema({ threadId: { type: "string" }, turnId: { type: "string" } }, ["threadId", "turnId"]),
    TurnStartedNotification: objectSchema({ threadId: { type: "string" }, turn: { type: "object" } }, ["threadId", "turn"]),
    AgentMessageDeltaNotification: objectSchema({ threadId: { type: "string" }, turnId: { type: "string" }, itemId: { type: "string" }, delta: { type: "string" } }, ["threadId", "turnId", "itemId", "delta"]),
    TurnCompletedNotification: objectSchema({ threadId: { type: "string" }, turn: { type: "object" } }, ["threadId", "turn"]),
    CommandExecutionRequestApprovalParams: objectSchema({ threadId: { type: "string" }, turnId: { type: "string" }, itemId: { type: "string" } }, ["threadId", "turnId", "itemId"]),
    FileChangeRequestApprovalParams: objectSchema({ threadId: { type: "string" }, turnId: { type: "string" }, itemId: { type: "string" } }, ["threadId", "turnId", "itemId"]),
  };
  definitions.ClientRequest = { oneOf: [
    envelope("initialize", "#/definitions/InitializeParams"),
    envelope("model/list", "#/definitions/ModelListParams"),
    envelope("thread/start", "#/definitions/ThreadStartParams"),
    envelope("thread/resume", "#/definitions/ThreadResumeParams"),
    envelope("turn/start", "#/definitions/TurnStartParams"),
    envelope("turn/interrupt", "#/definitions/TurnInterruptParams"),
  ] };
  definitions.ServerNotification = { oneOf: [
    envelope("turn/started", "#/definitions/TurnStartedNotification", { request: false }),
    envelope("item/agentMessage/delta", "#/definitions/AgentMessageDeltaNotification", { request: false }),
    envelope("turn/completed", "#/definitions/TurnCompletedNotification", { request: false }),
  ] };
  definitions.ServerRequest = { oneOf: [
    envelope("item/commandExecution/requestApproval", "#/definitions/CommandExecutionRequestApprovalParams"),
    envelope("item/fileChange/requestApproval", "#/definitions/FileChangeRequestApprovalParams"),
  ] };
  return { definitions };
}
```

- [ ] **Step 2: Add the regression test**

```js
test("reads the canonical schema bundle without enumerating split schemas", async () => {
  let readDirectoryCalls = 0;
  let requestedPath;
  const result = await installation.readGeneratedSchemas("C:\\generated", {
    readDirectory: async () => {
      readDirectoryCalls += 1;
      return Array.from({ length: 304 }, (_, index) => ({
        name: `split-${index}.json`,
        parentPath: "C:\\generated",
        isFile: () => true,
      }));
    },
    readSchemaFile: async (path) => {
      requestedPath = path;
      return JSON.stringify(canonicalSchemaBundle());
    },
  });

  assert.equal(readDirectoryCalls, 0);
  assert.equal(requestedPath, "C:\\generated\\codex_app_server_protocol.schemas.json");
  assert.equal(result.schemaSubsetCompatible, true);
});
```

- [ ] **Step 3: Add the unreadable canonical-file fail-closed test**

```js
test("fails closed when the canonical generated schema cannot be read", async () => {
  await assert.rejects(
    installation.readGeneratedSchemas("C:\\generated", {
      readDirectory: async () => [{
        name: "codex_app_server_protocol.schemas.json",
        parentPath: "C:\\generated",
        isFile: () => true,
      }],
      readSchemaFile: async () => { throw new Error("raw filesystem detail"); },
    }),
    (error) => error.code === "invalid_installation_configuration"
      && error.details.reason === "required_generated_schema_missing"
      && !JSON.stringify(error).includes("raw filesystem detail"),
  );
});
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test test/installation.test.js
```

Expected: the split-schema test fails with `invalid_generated_schema_set`, and
the unreadable-file test exposes an unnormalized read failure. Both failures
come from the missing canonical-only loader behavior.

- [ ] **Step 5: Implement the minimal canonical loader**

Add constants and replace the loader body:

```js
const APP_SERVER_SCHEMA_BUNDLE = "codex_app_server_protocol.schemas.json";
const MAX_GENERATED_SCHEMA_BYTES = 4 * 1024 * 1024;

export async function readGeneratedSchemas(directory, { readSchemaFile = readFile } = {}) {
  let raw;
  try {
    raw = await readSchemaFile(win32.join(directory, APP_SERVER_SCHEMA_BUNDLE), "utf8");
  } catch {
    throw new InstallationConfigError("required_generated_schema_missing");
  }
  if (typeof raw !== "string") throw new InstallationConfigError("invalid_generated_schema_json");
  if (Buffer.byteLength(raw, "utf8") > MAX_GENERATED_SCHEMA_BYTES) {
    throw new InstallationConfigError("generated_schema_too_large");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InstallationConfigError("invalid_generated_schema_json");
  }
  if (!parsed?.definitions?.ClientRequest || !parsed?.definitions?.ServerRequest) {
    throw new InstallationConfigError("required_generated_schema_missing");
  }
  return combineSchemaQualifications(
    qualifyStableSchemaBundle(parsed),
    qualifyApprovalSchemaBundle(parsed),
  );
}
```

Remove the obsolete `readDirectory` argument at the production call site:

```js
return readGeneratedSchemas(schemaDirectory, {
  readSchemaFile: fsApi.readFile,
});
```

- [ ] **Step 6: Run focused and complete tests and verify GREEN**

Run:

```powershell
node --test test/installation.test.js
npm test
```

Expected: focused tests and all companion tests pass with zero failures.

### Task 3: Verify and commit the scoped implementation

**Files:**
- Modify: `integrations/codex-gemini-executor/src/installation.js`
- Modify: `integrations/codex-gemini-executor/test/installation.test.js`

- [ ] **Step 1: Review scope and formatting**

Run:

```powershell
git diff --check
git diff -- integrations/codex-gemini-executor/src/installation.js integrations/codex-gemini-executor/test/installation.test.js
```

Expected: no whitespace errors and no changes outside the canonical loader and
focused tests.

- [ ] **Step 2: Stage only the implementation files**

```powershell
git add -- integrations/codex-gemini-executor/src/installation.js integrations/codex-gemini-executor/test/installation.test.js
git diff --cached --check
git diff --cached --name-only
git diff --cached --stat
```

Expected: exactly the two implementation files are staged.

- [ ] **Step 3: Run staged Gitleaks**

```powershell
& "C:\Users\Admin\.codex\tools\security\bin\gitleaks.exe" git --staged --redact --no-banner .
```

Expected: exit code 0 and no leaks. OSV is not required unless a dependency
manifest or lockfile unexpectedly changes.

- [ ] **Step 4: Commit the verified implementation**

```powershell
git commit -m "fix(companion): load canonical App Server schema bundle"
```

Expected: a commit containing exactly the two scoped files.

### Task 4: Install and run one bounded live acceptance gate

**Files:**
- Create outside Git: `C:\Users\Admin\Documents\Codex\9router-gemini-companion\<new-commit>\**`
- Create outside Git: one configuration checkpoint under `C:\Users\Admin\Documents\Codex\codex-portable-capabilities-checkpoints\`
- Update through Desktop App Server CLI: the `nine-router-gemini` MCP registration

- [ ] **Step 1: Re-read the machine runbook and inspect current MCP state**

Read `STATUS.md` and `PLUGIN-INSTALLATION-RUNBOOK.md`, then use:

```powershell
& "C:\Users\Admin\.codex\plugins\.plugin-appserver\codex.exe" mcp get nine-router-gemini
```

Expected: current registration still points to the immutable `c97e934d`
release and contains no literal API key.

- [ ] **Step 2: Create a checkpoint and immutable installation**

Copy only the tracked companion package at the new commit into an immutable
commit-named directory. Preserve `c97e934d`; do not delete or overwrite it.

- [ ] **Step 3: Update registration through the exact Desktop CLI**

Use the runbook-prescribed command path. Keep the API key in the existing user
environment and pass only non-secret executable, baseline, model, and permitted
workspace settings in MCP configuration.

- [ ] **Step 4: Verify tool discovery**

Initialize the installed MCP server directly and confirm exactly:

```text
run_gemini_task
get_gemini_status
cancel_gemini_task
```

- [ ] **Step 5: Run exactly one live request**

Start the production 9Router server, submit one read-only request through the
installed companion with expected marker `COMPANION_INSTALL_OK`, and capture
sanitized boundary evidence showing:

```text
Codex App Server -> 9Router -> Gemini route -> upstream success -> Codex response
```

Expected: terminal success containing `COMPANION_INSTALL_OK`, no workspace file
changes, and no secret values in output. Stop after this request whether it
passes or fails; classify any failure at the first observed boundary.

- [ ] **Step 6: Stop the temporary production server and verify rollback state**

Expected: port 20128 is free, the old `c97e934d` release and new checkpoint are
retained, and unrelated working-tree changes are untouched.
