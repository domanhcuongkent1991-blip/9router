# Codex Gemini Session Adapter Phase 2B Implementation Plan

> **For agent 2:** Execute this plan in the existing agent 2 chat. Do not create subagents. Use TDD and commit each task separately.

**Goal:** Add a small normalized thread/turn contract behind the App Server adapter, using only fake clients and protocol fixtures.

**Architecture:** One session-command module owns the four mutating App Server method names and converts fixed companion policy into raw requests. One event module maps only the three notifications required for a minimal text turn. Both modules fail closed with sanitized compatibility errors; other companion code never parses raw App Server messages.

**Tech Stack:** Node.js ES modules and built-in `node:test`; no dependencies, process launch, provider call, Desktop state, or workspace mutation.

---

## Scope

Agent 2 may modify only:

```text
integrations/codex-gemini-executor/**
```

Do not alter the root project, provider configuration, plugin/MCP state, user workspaces, or existing process/handshake behavior. Do not push, merge, deploy, install packages, or run a real App Server.

## Locked normalized contract

`createAppServerSessionAdapter` receives one fixed model and model-provider id at construction. Callers cannot override either value.

```js
const session = createAppServerSessionAdapter({
  client,
  fixedModel: "gemini-fixed",
  fixedModelProvider: "nine_router",
});

await session.startThread({ cwd, sandbox, approvalPolicy });
// => { threadId }

await session.resumeThread({ threadId, cwd, sandbox, approvalPolicy });
// => { threadId }

await session.startTurn({ threadId, task, effort });
// => { threadId, turnId, status: "running" }

await session.interruptTurn({ threadId, turnId });
// => { threadId, turnId, status: "interrupt_requested" }
```

Allowed policy values:

- `sandbox`: `read-only` or `workspace-write`; never `danger-full-access`;
- `approvalPolicy`: `on-request` or `never`;
- `effort`: `low`, `medium`, or `high`;
- ids/model/provider: non-empty UTF-8 strings, maximum `512` bytes;
- task: non-empty after trim, maximum `64 KiB`;
- `cwd`: absolute Windows or POSIX path, maximum `4096` bytes.

Raw requests are fixed:

```js
client.request("thread/start", {
  cwd,
  model: fixedModel,
  modelProvider: fixedModelProvider,
  sandbox,
  approvalPolicy,
  ephemeral: false,
});

client.request("thread/resume", {
  threadId,
  cwd,
  model: fixedModel,
  modelProvider: fixedModelProvider,
  sandbox,
  approvalPolicy,
});

client.request("turn/start", {
  threadId,
  input: [{ type: "text", text: task.trim() }],
  model: fixedModel,
  effort,
});

client.request("turn/interrupt", { threadId, turnId });
```

The notification normalizer supports only:

```text
turn/started
item/agentMessage/delta
turn/completed
```

Unknown notification methods return `null` and are not persisted. A malformed supported notification throws `AppServerCompatibilityError` with user message `Codex version chưa được hỗ trợ`; error details contain only `{stage:"event", method, reason}`.

### Task 1: Add normalized session commands

**Files:**
- Create: `integrations/codex-gemini-executor/src/app-server/session.js`
- Create: `integrations/codex-gemini-executor/test/session.test.js`

- [ ] **Step 1: Write failing tests**

Cover all four methods and assert the exact raw requests shown above. Add tests proving:

- fixed model/provider are used and no caller override is accepted;
- resume response `thread.id` must equal the requested id;
- thread response must contain a bounded non-empty `thread.id`;
- turn response must contain a bounded non-empty `turn.id` and `turn.status === "inProgress"`;
- interrupt accepts only an object response and returns `interrupt_requested`;
- every invalid input is rejected before `client.request` runs;
- transport and malformed response errors become sanitized `AppServerSessionError` values containing only fixed reason/stage/cause-type fields.

Use a recording fake client. Tests must not import or invoke process, fs, network, or workspace modules.

- [ ] **Step 2: Confirm RED**

```powershell
node --test integrations/codex-gemini-executor/test/session.test.js
```

Expected: module-not-found failure for `src/app-server/session.js`.

- [ ] **Step 3: Implement the minimal module**

Export only:

```js
export class AppServerSessionError extends Error
export function createAppServerSessionAdapter({ client, fixedModel, fixedModelProvider })
```

The returned frozen object exposes only `startThread`, `resumeThread`, `startTurn`, and `interruptTurn`. Keep all raw method and wire-field names in this module. Do not retain raw responses, task text, cwd, or remote error messages in thrown errors.

- [ ] **Step 4: Confirm GREEN and commit**

```powershell
node --test integrations/codex-gemini-executor/test/session.test.js
git add -- integrations/codex-gemini-executor/src/app-server/session.js integrations/codex-gemini-executor/test/session.test.js
git diff --cached --check
gitleaks git --staged --redact --no-banner --no-color
git commit -m "feat: normalize App Server session commands"
```

Expected: session tests pass and the staged secret scan is clean.

### Task 2: Add minimal text-turn event normalization

**Files:**
- Create: `integrations/codex-gemini-executor/src/app-server/events.js`
- Create: `integrations/codex-gemini-executor/test/events.test.js`

- [ ] **Step 1: Write failing tests for exact mappings**

Lock these outputs:

```js
normalizeAppServerNotification({
  method: "turn/started",
  params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status: "inProgress" } },
});
// { type: "turn_started", threadId: "thr_1", turnId: "turn_1", status: "running" }

normalizeAppServerNotification({
  method: "item/agentMessage/delta",
  params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "hello" },
});
// { type: "assistant_delta", threadId: "thr_1", turnId: "turn_1", itemId: "item_1", text: "hello" }

normalizeAppServerNotification({
  method: "turn/completed",
  params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status: "completed" } },
});
// { type: "turn_completed", threadId: "thr_1", turnId: "turn_1", status: "completed" }
```

Map completed statuses exactly:

```text
completed   -> completed
interrupted -> cancelled
failed      -> failed
```

Reject `inProgress` in a `turn/completed` notification. Validate every id with the same 512-byte rule and delta as a string no larger than `1 MiB`; an empty delta is allowed. Ignore unknown methods by returning `null`, even if their params are unfamiliar. Reject non-object messages, non-string method names, missing/malformed supported params, and unsupported completed statuses without retaining raw content.

- [ ] **Step 2: Confirm RED**

```powershell
node --test integrations/codex-gemini-executor/test/events.test.js
```

Expected: module-not-found failure for `src/app-server/events.js`.

- [ ] **Step 3: Implement the minimal normalizer**

Export only:

```js
export function normalizeAppServerNotification(message)
```

Reuse `AppServerCompatibilityError` from `compatibility.js`. Do not add a second user-facing incompatibility type. Supported event failures must use details `{ stage: "event", method, reason }`; unknown events return `null` before params are examined.

- [ ] **Step 4: Confirm GREEN and commit**

```powershell
node --test integrations/codex-gemini-executor/test/events.test.js
git add -- integrations/codex-gemini-executor/src/app-server/events.js integrations/codex-gemini-executor/test/events.test.js
git diff --cached --check
gitleaks git --staged --redact --no-banner --no-color
git commit -m "feat: normalize App Server turn events"
```

Expected: event tests pass and the staged secret scan is clean.

### Task 3: Final offline verification

- [ ] **Step 1: Run the whole isolated package**

```powershell
npm --prefix integrations/codex-gemini-executor test
```

Expected: every test passes and Node exits normally.

- [ ] **Step 2: Verify scope and secrets**

```powershell
git diff --check 01cfaefb..HEAD
git diff --name-only 01cfaefb..HEAD
gitleaks git --log-opts="01cfaefb..HEAD" --redact --no-banner --no-color
git status --short
```

Expected: only the four Phase 2B files changed, no staged files, no leaks, and unrelated root changes remain untouched.

- [ ] **Step 3: Report limitations accurately**

Confirm no live App Server/provider/workspace action occurred. Approval requests, notification routing, accumulated output, timeout/cancellation coordination, live schema/handshake qualification, and process/session composition remain outside Phase 2B.
