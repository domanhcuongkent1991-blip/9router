# Codex Gemini Approval Boundary Phase 2C2 Implementation Plan

> **For agent 2:** Execute in the existing agent 2 chat without subagents. Use TDD and commit each task separately.

**Goal:** Add the bounded JSONL response path and a fail-closed, one-request-at-a-time approval relay for command and file-change requests using fakes only.

**Architecture:** The JSONL client tracks server request ids and permits exactly one result response for each received request. A separate approval adapter validates active thread/turn identity, sanitizes display fields through an injected redactor, obtains one explicit decision, and returns only `accept`, `decline`, or `cancel` to App Server. Timeout, host failure, invalid identity, invalid decision, or unsupported approval shape never auto-accepts.

**Tech Stack:** Node.js ES modules and built-in `node:test`; no dependencies, MCP UI, live App Server, provider, process, or workspace.

---

## Scope

Agent 2 may modify only:

```text
integrations/codex-gemini-executor/src/app-server/jsonl-client.js
integrations/codex-gemini-executor/test/jsonl-client.test.js
integrations/codex-gemini-executor/src/app-server/approvals.js
integrations/codex-gemini-executor/test/approvals.test.js
```

Do not change schema/session/event/handshake/process behavior, root files, Desktop/plugin/MCP state, provider configuration, or workspaces. Do not install, push, merge, deploy, or run a real process/provider.

## Locked approval policy

- Supported server requests:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
- Accepted user decisions: `accept`, `decline`, `cancel` only.
- Never send `acceptForSession`, exec-policy amendments, network-policy amendments, or persistent grants.
- A non-null file-change `grantRoot` is unsupported and fails closed.
- Request id is a safe integer or a non-empty string of at most `512` UTF-8 bytes.
- Thread, turn, and item ids are non-empty strings of at most `512` bytes and must match the active turn where applicable.
- Command is nullable/string up to `64 KiB`; reason is nullable/string up to `16 KiB`; cwd is nullable absolute Windows/POSIX path up to `4096` bytes.
- Display values must pass through an injected `sanitizeForDisplay(value)` before `requestDecision` receives them. Any sanitizer failure cancels the request and exposes no raw value.
- Approval timeout is bounded between `1` and `300_000` ms. Timeout or decision-provider failure sends `cancel`, then throws a sanitized approval error so the later job coordinator can interrupt the turn.

### Task 1: Add one-response JSONL server-request tracking

**Files:**
- Modify: `integrations/codex-gemini-executor/src/app-server/jsonl-client.js`
- Modify: `integrations/codex-gemini-executor/test/jsonl-client.test.js`

- [ ] **Step 1: Write failing tests**

Prove:

1. Receiving `{method,id,params}` records the server request before invoking `onServerRequest`.
2. `client.respond(id, result)` writes exactly `{id,result}` plus one newline and no `jsonrpc` field.
3. Only safe-integer or bounded non-empty string ids are accepted.
4. Unknown, duplicate, already-responded, or more than `8` simultaneously outstanding server request ids fail the connection with sanitized `AppServerProtocolError`.
5. `respond` may be called once per id; serialization/output-size errors close the connection and reject all pending client requests.
6. `close()` clears outstanding server requests; later responses reject without writing.
7. A response may be sent synchronously inside `onServerRequest`.

- [ ] **Step 2: Confirm RED**

```powershell
node --test integrations/codex-gemini-executor/test/jsonl-client.test.js
```

Expected: failures because `respond` and server-request tracking do not exist.

- [ ] **Step 3: Implement the minimal response path**

Add `respond` to the existing frozen client return value:

```js
Object.freeze({ request, notify, respond, close, isClosed })
```

Track at most eight outstanding server ids in a `Map`/`Set`. Register before callback dispatch, remove only after the response frame is successfully written, and clear on finish. Do not add a generic raw-send API or a JSON-RPC error-response API in this phase.

- [ ] **Step 4: Verify and commit**

```powershell
node --test integrations/codex-gemini-executor/test/jsonl-client.test.js
git add -- integrations/codex-gemini-executor/src/app-server/jsonl-client.js integrations/codex-gemini-executor/test/jsonl-client.test.js
git diff --cached --check
gitleaks git --staged --redact --no-banner --no-color
git commit -m "feat: respond to App Server requests once"
```

### Task 2: Add the normalized approval relay

**Files:**
- Create: `integrations/codex-gemini-executor/src/app-server/approvals.js`
- Create: `integrations/codex-gemini-executor/test/approvals.test.js`

- [ ] **Step 1: Write failing approval tests**

Create the adapter with:

```js
const approvals = createAppServerApprovalAdapter({
  respond: client.respond,
  requestDecision,
  sanitizeForDisplay,
  timeoutMs: 1_000,
});

await approvals.handle(message, {
  jobId: "job_1",
  threadId: "thr_1",
  turnId: "turn_1",
});
```

For command approval, `requestDecision` receives exactly:

```js
{
  type: "command",
  jobId: "job_1",
  threadId: "thr_1",
  turnId: "turn_1",
  itemId: "item_1",
  command: "<sanitized nullable value>",
  cwd: "<sanitized nullable value>",
  reason: "<sanitized nullable value>",
  decisions: ["accept", "decline", "cancel"],
}
```

For file approval, use `type: "file_change"`, omit command/cwd, include sanitized reason, and reject a non-null `grantRoot`.

Tests must prove:

- each valid explicit decision calls `respond(requestId, {decision})` exactly once and returns `{decision}`;
- `acceptForSession`, objects, empty values, and unknown decisions are never forwarded;
- wrong job/thread/turn identity, invalid item/request id, duplicate in-flight request id, malformed supported request, unsupported server method, or non-null `grantRoot` fails closed;
- sanitizer runs separately for every display field before `requestDecision`, and sentinel secrets never appear in returned/thrown values;
- sanitizer failure, decision-provider throw/rejection, timeout, or invalid decision attempts `respond(id,{decision:"cancel"})` exactly once and throws `AppServerApprovalError` containing only `{reason,stage,causeType?}`;
- failure to send the cancel response is reported as sanitized `cancel_response_failed` without replacing it with raw transport data;
- the adapter permits only one active approval at a time; a second request is cancelled and rejected rather than queued;
- timers are cleared on every path and use `unref` when available.

- [ ] **Step 2: Confirm RED**

```powershell
node --test integrations/codex-gemini-executor/test/approvals.test.js
```

Expected: module-not-found failure for `src/app-server/approvals.js`.

- [ ] **Step 3: Implement the minimal adapter**

Export only:

```js
export class AppServerApprovalError extends Error
export function createAppServerApprovalAdapter({
  respond,
  requestDecision,
  sanitizeForDisplay,
  timeoutMs,
})
```

The frozen adapter exposes only `handle`. Keep raw App Server method/field names inside this file. Unsupported/malformed App Server contract uses `AppServerCompatibilityError`; operational approval failures use sanitized `AppServerApprovalError`. Never retain message, params, commands, paths, reasons, sanitizer output, or remote errors in error objects.

`requestDecision` is injected for later MCP elicitation; this phase does not create an MCP tool or UI. `sanitizeForDisplay` is injected for the later security boundary; tests use a deterministic sentinel redactor.

- [ ] **Step 4: Verify and commit**

```powershell
node --test integrations/codex-gemini-executor/test/approvals.test.js
npm --prefix integrations/codex-gemini-executor test
git add -- integrations/codex-gemini-executor/src/app-server/approvals.js integrations/codex-gemini-executor/test/approvals.test.js
git diff --cached --check
gitleaks git --staged --redact --no-banner --no-color
git commit -m "feat: add fail-closed App Server approvals"
```

### Task 3: Final verification and handoff

```powershell
npm --prefix integrations/codex-gemini-executor test
git diff --check 84a67a47..HEAD
git diff --name-only 84a67a47..HEAD
gitleaks git --log-opts="84a67a47..HEAD" --redact --no-banner --no-color
git status --short
```

Expected: all tests pass, only four authorized files changed, no staged file or leak, and unrelated dirty root files remain untouched.

Report that this remains offline. Real MCP elicitation, real redaction implementation, turn interruption after approval failure, event routing, provider calls, and workspace mutation remain outside Phase 2C2.
