# Codex Gemini Required Events Schema Phase 2C1 Implementation Plan

> **For agent 2:** Execute in the existing agent 2 chat without subagents. Use TDD and one implementation commit.

**Goal:** Extend capability-first qualification so a Desktop update cannot pass startup when required turn notifications or approval requests have disappeared or changed shape.

**Architecture:** Keep the existing stable v2 request qualifier, add structural checks for the three notifications consumed by Phase 2B, and add a separate qualifier for the two approval server requests emitted from the root schema bundle. A tiny combiner produces the existing handshake shape; no runtime, provider, approval UI, or workspace code changes.

**Tech Stack:** Node.js ES modules and built-in `node:test`; no dependencies or live process.

---

## Scope

Modify only:

```text
integrations/codex-gemini-executor/src/app-server/schema-qualification.js
integrations/codex-gemini-executor/test/schema-qualification.test.js
integrations/codex-gemini-executor/test/adapter.test.js
```

Do not alter session/event behavior, process/transport/handshake modules, root files, Desktop/plugin/MCP state, provider configuration, or any workspace. Do not push, merge, deploy, install, or run a live App Server.

## Exact required schema subset

Stable v2 `definitions.ClientRequest.oneOf` remains:

```text
initialize      -> #/definitions/InitializeParams
model/list      -> #/definitions/ModelListParams
thread/start    -> #/definitions/ThreadStartParams
thread/resume   -> #/definitions/ThreadResumeParams
turn/start      -> #/definitions/TurnStartParams
turn/interrupt  -> #/definitions/TurnInterruptParams
```

Stable v2 `definitions.ServerNotification.oneOf` adds:

```text
turn/started                    -> #/definitions/TurnStartedNotification
item/agentMessage/delta         -> #/definitions/AgentMessageDeltaNotification
turn/completed                  -> #/definitions/TurnCompletedNotification
```

Root `definitions.ServerRequest.oneOf` adds:

```text
item/commandExecution/requestApproval -> #/definitions/CommandExecutionRequestApprovalParams
item/fileChange/requestApproval       -> #/definitions/FileChangeRequestApprovalParams
```

A valid variant has exactly one string method enum, requires `method` and `params`, has the exact params `$ref`, and—when it is a request—also requires `id`. Additive fields and unrelated variants remain compatible. Duplicate consumed variants are incompatible.

### Task 1: Extend structural qualification

- [ ] **Step 1: Write failing tests**

Update fixtures so `qualifyStableSchemaBundle` receives both `ClientRequest` and `ServerNotification`. Add tests proving:

- exact client methods plus all three notifications pass;
- removing or changing one notification makes `schemaSubsetCompatible` false while client `methods` remain accurate;
- unrelated notifications and additive fields pass;
- description/arbitrary-string occurrences do not count;
- duplicate consumed notification variants fail.

Add root-bundle fixtures and tests for:

```js
qualifyApprovalSchemaBundle(rootBundle)
// {
//   schemaSubsetCompatible: true,
//   serverRequests: {
//     "item/commandExecution/requestApproval": true,
//     "item/fileChange/requestApproval": true,
//   },
// }
```

Missing, duplicate, malformed, or wrong-ref approval variants return `schemaSubsetCompatible: false`. Invalid root bundle structure throws the existing sanitized `AppServerSchemaError`.

Add combiner tests:

```js
combineSchemaQualifications(stable, approvals)
// { schemaSubsetCompatible: true, methods: stable.methods }
```

The combined flag is true only when both inputs are structurally valid and compatible. Returned output contains only `schemaSubsetCompatible` and the five required client `methods`, matching `createStableHandshakeDriver` without changing its API.

- [ ] **Step 2: Confirm RED**

```powershell
node --test integrations/codex-gemini-executor/test/schema-qualification.test.js integrations/codex-gemini-executor/test/adapter.test.js
```

Expected: failures because notification, approval, and combiner exports do not exist.

- [ ] **Step 3: Implement minimal structural helpers**

Keep all expected method/ref tables private. Export only the existing API plus:

```js
export function qualifyApprovalSchemaBundle(bundle)
export function combineSchemaQualifications(stable, approvals)
```

Reuse one private structural variant checker for request and notification definitions. Do not recursively search the schema, compare full generated bundles, add a JSON Schema library, or retain raw schema content in errors.

Update the adapter composition fixture to build both schema bundles, combine them, and pass the combined result to `createStableHandshakeDriver`. Prove that:

- changed version/hash plus complete required contract still warns and passes;
- missing required notification fails with `app_server_incompatible` even when every client method exists;
- missing required approval request also fails with `app_server_incompatible`.

- [ ] **Step 4: Verify and commit**

```powershell
node --test integrations/codex-gemini-executor/test/schema-qualification.test.js integrations/codex-gemini-executor/test/adapter.test.js
npm --prefix integrations/codex-gemini-executor test
git add -- integrations/codex-gemini-executor/src/app-server/schema-qualification.js integrations/codex-gemini-executor/test/schema-qualification.test.js integrations/codex-gemini-executor/test/adapter.test.js
git diff --cached --check
gitleaks git --staged --redact --no-banner --no-color
git commit -m "feat: qualify required App Server events"
```

Expected: all package tests pass; staged Gitleaks is clean.

### Task 2: Handoff

- [ ] **Step 1: Verify scope after commit**

```powershell
git diff --check cfea1f6e..HEAD
git diff --name-only cfea1f6e..HEAD
gitleaks git --log-opts="cfea1f6e..HEAD" --redact --no-banner --no-color
git status --short
```

Expected: only the three authorized files changed, no staged files, no leak, and unrelated dirty files are untouched.

- [ ] **Step 2: Report accurately**

Report commit, files, test counts, and confirmation that schema qualification now gates required client methods, notifications, and approval server requests. State clearly that live schema generation/reading, approval decisions, event routing, provider calls, and workspace changes remain unimplemented.
