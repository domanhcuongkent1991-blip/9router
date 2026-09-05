# Codex Gemini Executor Companion Design

## Status

Approved by the project director on 2026-09-05. This document defines the
design boundary for making Gemini convenient to use from Codex Desktop without
replacing the normal ChatGPT Plus/OpenAI path or changing how 9Router operates
for its existing users.

## Goal

Add an opt-in Gemini execution path that lets a user start a real coding task
from Codex Desktop while Gemini performs the reasoning and uses an isolated
Codex harness for file reads, edits, shell commands, tests, approvals, streaming,
and multi-turn continuation.

The design prioritizes, in order:

1. stability;
2. correctness;
3. recoverability;
4. testability;
5. maintainability;
6. runtime portability;
7. delivery speed.

## User Experience

The normal Codex Desktop session remains signed in with ChatGPT Plus and keeps
the OpenAI provider as its default. Gemini runs only after an explicit request,
for example:

```text
Use Gemini High to fix this streaming bug, run the relevant tests, and do not commit.
```

Codex Desktop calls a local MCP tool. The tool starts a separate Codex App
Server session configured for Gemini through 9Router and returns a structured
result containing:

- job and session identifiers;
- terminal status or approval-required status;
- workspace or worktree path;
- files changed;
- tests run and their results;
- a concise final response;
- failure category and recovery guidance when applicable.

Supported effort values are `low`, `medium`, and `high`. `xhigh` is not exposed
because the current 9Router Gemini mapping reduces it to `high`; presenting it
as a separate capability would be misleading.

## Non-goals

This work will not:

- patch the Codex Desktop executable, `app.asar`, model picker, or installed
  application files;
- replace the default OpenAI provider or route ordinary GPT Plus requests
  through 9Router;
- add a second chat application or a new 9Router dashboard;
- make Gemini run automatically without an explicit user request;
- allow automatic dependency downloads, commits, pushes, merges, deployments,
  destructive cleanup, or unrestricted filesystem access;
- emulate OpenAI hosted Responses features that the existing stateless adapter
  does not support;
- add continuous monitoring or periodic polling.

## Alternatives Considered

### Add Gemini to the Codex Desktop model picker

This offers the most familiar interface but depends on Desktop behavior that is
not guaranteed for third-party models. A runtime hook or application patch would
raise update, privacy, and recovery risk. It is rejected as the production
foundation. A future configuration-only experiment may be performed separately
only if it requires no patch or hook.

### Expose an `ask_gemini` consultation tool

This is easy to isolate, but Gemini would only return text while GPT remained
the executing model. It does not satisfy the requirement that Gemini perform
the task. Rejected.

### Run a Gemini Codex profile manually from a terminal

This gives Gemini the Codex harness and is the safest technical fallback, but
it is not convenient for a non-technical user. Retained only as the recovery
path if the Desktop companion cannot pass its third integration review.

### Use a local Gemini Executor companion

Selected. Codex Desktop remains the user-facing coordinator, while an isolated
App Server session uses Gemini as the reasoning model and the Codex harness as
the controlled execution layer.

## Architecture

```text
Codex Desktop (ChatGPT Plus / OpenAI default)
        |
        | local MCP tool call
        v
Gemini Executor Companion
        |-- input validation and fixed model allowlist
        |-- workspace validation and single-writer lock
        |-- job/session lifecycle, timeout, and cancellation
        |-- approval relay and secret redaction
        v
Isolated Codex App Server
        |-- separate CODEX_HOME
        |-- workspace-write or read-only sandbox
        |-- low / medium / high effort
        v
9Router http://127.0.0.1:20128/v1/responses
        v
Antigravity / Gemini
```

### Failure isolation

9Router remains an independent gateway. The companion consumes its existing
public LLM boundary as a client and does not become part of 9Router startup,
provider management, dashboard authentication, database initialization, or
shutdown. If the companion, child App Server, Antigravity, or Gemini fails,
ordinary GPT Plus work in Codex Desktop remains available.

No dependency from the companion is added to the root 9Router `package.json`.
The companion has its own package manifest, lockfile, tests, and process
lifecycle under:

```text
D:\9Router\integrations\codex-gemini-executor\
```

Persistent local runtime data is stored under:

```text
C:\Users\Admin\Documents\Codex\9router-gemini-runtime\
```

Disposable test jobs and task worktrees are stored in task-specific directories
under:

```text
C:\tmp\CodexScratch\9router-gemini-jobs\
```

The implementation must not create a workspace directly under `C:\tmp` or use
`E:\CodexWork`.

## Component Responsibilities

### MCP bridge

The MCP bridge exposes exactly three user-facing operations:

- `run_gemini_task`: start a job or continue a supplied Gemini session;
- `get_gemini_status`: read persisted status on demand;
- `cancel_gemini_task`: cancel the selected job and terminate its child process.

The bridge validates arguments and delegates lifecycle work. It does not contain
provider routing or Responses translation logic.

### Gemini Executor

The executor:

- accepts only the fixed Gemini model configured for this installation;
- accepts only `low`, `medium`, or `high` effort;
- resolves and validates the workspace before starting any process;
- prevents two write-capable Gemini jobs from using the same repository at the
  same time;
- launches only the App Server executable selected and recorded during the
  installation verification; it does not resolve an arbitrary `codex` binary
  from `PATH` at runtime;
- starts App Server with a separate `CODEX_HOME` that does not load the parent
  Gemini MCP server;
- forwards App Server progress, terminal events, errors, and approval requests;
- applies idle and hard timeouts;
- propagates cancellation and cleans up known child processes;
- persists only minimal job metadata required for continuation and recovery.

### Isolated Codex App Server

The child App Server supplies the Codex harness. Each thread receives an
explicit model, effort, working directory, approval policy, and sandbox policy.

Analysis jobs use a read-only sandbox. Code-changing jobs use workspace-write
with one exact writable root. Network access is off by default. App Server and
Codex CLI compatibility must be checked at startup; unsupported protocol or
configuration versions fail closed with an actionable error.

### 9Router

9Router continues to own:

- `/v1/responses` request validation and stateless compatibility;
- model/provider routing;
- Antigravity authentication and token refresh;
- provider request and response translation;
- streaming and tool-call transport;
- usage accounting and provider error normalization.

The companion may call `GET /api/health` and `/v1/models` before starting a job,
then call `/v1/responses`. It must not call provider-management, dashboard,
database, update, tunnel, shutdown, or credential-import routes.

## Request and Result Contract

### `run_gemini_task`

Required input:

- `task`: non-empty task text with a bounded length;
- `workspace`: an absolute existing directory inside an explicitly permitted
  workspace root.

Optional input:

- `effort`: `low`, `medium`, or `high`; defaults to `medium`;
- `access`: `read-only` or `workspace-write`; defaults to `read-only`;
- `session_id`: an existing executor-owned Gemini session to continue;
- `timeout_minutes`: a bounded value within the configured minimum and maximum.

The tool never accepts a provider URL, arbitrary model identifier, API key,
shell command, `CODEX_HOME`, or unrestricted writable root from the prompt.

### Approval response flow

An approval request is relayed inside the active `run_gemini_task` call using
MCP elicitation. The request includes the Gemini job, App Server thread and
turn, requested command or file change, reason, and available decisions. The
companion forwards only the user's explicit `accept`, `decline`, or `cancel`
decision to the matching App Server request.

If the host cannot render elicitation, the tool call disconnects, the request
identity does not match, or the approval wait expires, the companion treats the
request as denied, cancels the turn, and returns a sanitized failure. It does
not add a fourth approval tool, reuse an approval across requests, or accept an
operation because the user approved a previous turn. `awaiting_approval` is a
live job state visible to `get_gemini_status`, not an indefinitely persisted
authorization.

### Standard statuses

```text
starting
running
awaiting_approval
completed
failed
cancelled
```

### Terminal result

The result is structured and bounded. It contains metadata, a concise final
answer, file changes, test results, and sanitized error details. Raw bearer
tokens, cookies, complete environment dumps, `.env` contents, or arbitrary raw
provider payloads are never returned.

## Workspace and Git Policy

Read-only analysis may run against the selected repository without creating a
worktree. A write-capable task follows these rules:

1. inspect Git status before execution;
2. if the selected checkout is dirty, stop and report the existing changes;
3. do not stash, reset, clean, overwrite, or commit existing changes;
4. create a dedicated worktree from the exact current `HEAD` in a task-specific
   CodexScratch directory;
5. permit writes only in that worktree;
6. never push, merge, rebase, tag, deploy, or delete the worktree automatically;
7. return the worktree path and diff for review.

A single-writer lock is keyed by the canonical repository path. A second write
job receives a conflict response rather than waiting indefinitely. Read-only
jobs may coexist when they do not consume excessive resources.

## Security and Approval Policy

### Authentication and secret handling

- The companion uses a dedicated 9Router API key supplied by an environment
  variable or an operating-system credential mechanism; the key is never stored
  in a committed configuration file.
- The child App Server uses a separate `CODEX_HOME` and does not read the normal
  Desktop ChatGPT authentication state.
- Request logging remains disabled for this integration.
- Authorization, cookies, API keys, `.env` contents, provider credentials, and
  credential-like values are removed before persistence or display.
- Sentinel tests verify that secrets do not appear in success, failure, timeout,
  cancellation, or approval records.

### Command and filesystem controls

- Default network access is disabled.
- `danger-full-access` is not offered.
- Destructive filesystem commands, changes outside the writable root, and Git
  publication operations are rejected.
- Approval requests fail closed if the companion cannot relay them safely.
- Downloading dependencies or files must stop for user permission and include
  supplier, registry, repository, version, tarball origin, and integrity
  evidence before download.
- Dependency installation uses pinned versions and a lockfile. Lifecycle
  scripts are disabled when the package permits it. OSV and secret scans are run
  before promotion.

## Error and Recovery Behavior

Errors are categorized so the user receives a concrete recovery action:

- `router_unavailable`: start 9Router and retry;
- `model_unavailable`: restore the configured Antigravity/Gemini model;
- `provider_auth_failed`: reconnect Antigravity in 9Router;
- `provider_quota_exceeded`: wait for quota reset or stop the Gemini task;
- `app_server_incompatible`: keep GPT Plus active and use the CLI profile
  fallback until compatibility is restored;
- `workspace_dirty`: review or checkpoint the user's existing changes;
- `workspace_locked`: finish or cancel the existing writer job;
- `approval_required`: obtain an explicit decision; do not auto-accept;
- `timeout`: terminate the known child process and preserve sanitized metadata;
- `cancelled`: stop execution and leave the worktree intact for inspection;
- `protocol_error`: fail without retrying an unknown or lossy request shape.

Retries are bounded. The executor does not silently change the requested model,
provider, reasoning effort, workspace, or access level.

## Runtime Lifecycle

There is no periodic monitor. The MCP bridge is started by Codex Desktop when
needed. A Gemini job starts one child App Server process, observes that process
while the job is active, and tears it down on completion, cancellation, or hard
timeout. `get_gemini_status` reads state only when called.

Process records include enough identity to avoid terminating an unrelated
process after a restart. Startup recovery marks stale jobs failed and reports
their worktree locations; it does not delete their files.

## Dependency Policy

The implementation should prefer the already-installed Node.js runtime and a
small official MCP SDK package. Before any network download:

1. confirm the configured npm registry is `https://registry.npmjs.org/`;
2. query exact package metadata without installing;
3. verify the package repository belongs to the expected maintainer;
4. verify the tarball is hosted on the expected registry and has SHA-512
   integrity metadata;
5. pin the exact accepted version in the companion package;
6. install from the generated lockfile without lifecycle scripts where
   compatible;
7. run an OSV dependency scan and record only package/version findings.

No new root-runtime dependency is permitted.

## Delivery Phases and Ownership

### Phase 0: stabilize the existing Responses boundary

Agent 1 exclusively owns:

- `open-sse/compat/responses/**`;
- Responses-related translator and handler changes already present;
- `src/app/api/v1/responses/route.js`;
- Responses/Gemini compatibility tests and contract documentation.

Agent 1 must classify the existing dirty changes, exclude local logs and test
runtime state, execute targeted compatibility tests, diagnose the previously
stalled production build, and commit only the verified Responses scope.

Phase 0 is a hard prerequisite. If the production build cannot succeed or the
failure cannot be explained with evidence, companion implementation does not
start.

### Phase 1: build the offline companion core

Agent 2 exclusively owns:

```text
integrations/codex-gemini-executor/**
```

Agent 2 creates the isolated package, input validation, workspace lock,
lifecycle, redaction, and fake App Server/9Router tests. This phase uses no live
provider calls.

### Phase 2: connect the isolated App Server

Agent 2 adds App Server startup, handshake, thread start/resume, event mapping,
approval relay, cancellation, timeout, and child cleanup. The child environment
must not load the parent Gemini MCP server.

### Phase 3: controlled integration review

Kent reviews both ownership scopes and performs bounded integration tests:

- 9Router health and exact model availability;
- one read-only Gemini task;
- one write task against a disposable fixture/worktree;
- shell, patch, test, streaming, continuation, cancellation, timeout, and
  provider failure behavior;
- secret redaction and writer-lock enforcement;
- confirmation that GPT Plus still works when the companion or 9Router is off.

Only these bounded tests may call the configured Gemini provider. No broad or
repeated live test loop is authorized.

### Phase 4: package and install for Codex Desktop

Before changing local Plugin/MCP state, read the machine's capability status and
plugin installation runbook. Use the prescribed Desktop app-server and safe
plugin-state scripts; do not edit the main `config.toml` manually.

Create a configuration checkpoint, install the personal plugin/MCP, restart
Codex Desktop once, and validate from a new task. Disabling or uninstalling the
companion must leave both 9Router and GPT Plus unchanged.

The installer records the verified absolute App Server executable path and
version in companion configuration. Runtime startup fails closed if that file
is missing or its version no longer satisfies the tested protocol contract;
the companion never falls back to another executable found on `PATH`.

## Test Strategy

Development follows test-driven behavior at each boundary.

### Offline unit and contract tests

- reject empty tasks, relative paths, unapproved roots, unknown effort/access,
  arbitrary model/provider/base URL, and oversized input;
- accept the fixed supported contract and normalize defaults;
- enforce one writer per repository;
- verify read-only and workspace-write policy construction;
- verify fixed child environment and separate `CODEX_HOME`;
- verify process cancellation and timeout cleanup with fake processes;
- verify all error categories and bounded retry behavior;
- run secret sentinel tests over every persisted and returned field;
- verify the MCP tool schema and bounded output.

### App Server contract tests

- negotiate the actual installed App Server protocol and generated schema;
- start and resume a fake-provider thread;
- map progress, tool calls, approval requests, completion, failure, and
  cancellation;
- reject incompatible protocol or unexpected event shapes without silently
  dropping data.

### 9Router regression tests

- preserve dashboard authentication and ordinary API behavior;
- exercise the supported `/v1/responses` subset for namespace tools,
  `additional_tools`, tool output, streaming, non-streaming, cancellation, and
  OpenAI-shaped errors;
- verify Gemini schema cleanup and reasoning mapping;
- run the existing Responses/translator suite and production build.

### Bounded live acceptance tests

- complete one read-only task using the fixed Gemini model;
- complete one write-and-test task in a disposable worktree;
- continue the same Gemini session once;
- cancel one bounded task;
- simulate 9Router unavailability and confirm GPT Plus remains usable;
- inspect persisted state and logs for sentinel leakage.

Tests begin targeted and use no more than two workers. The production build runs
as a single process to avoid excessive CPU use.

## Risk Register

| Risk | Likelihood | Impact | Mitigation | Exit or recovery |
| --- | --- | --- | --- | --- |
| Current production build remains stalled | Present | High | Diagnose and pass Phase 0 before companion work | Stop companion work; preserve the existing CLI-profile fallback |
| Dirty working tree contaminates commits | Present | High | Explicit-file staging and cached-diff review; never use broad staging | Unstage only the incorrectly staged file and repeat scope review |
| App Server protocol changes after a Codex update | Medium | High | Handshake/version check and tests against the installed executable | Disable the companion; GPT Plus and 9Router continue normally |
| Gemini loses namespace or tool-call data | Medium | High | Contract tests for namespace, additional tools, calls, and outputs | Fail the task; never report a false success |
| Gemini modifies the wrong files | Low after controls | High | Dirty-check, dedicated worktree, exact writable root, writer lock | Cancel and inspect the retained worktree; do not merge |
| Existing user changes are lost | Low after controls | Critical | Never stash/reset/clean; reject dirty write targets | Stop before process start and report the dirty paths |
| Secret or source content leaks into logs | Medium without controls | High | Logging off, redaction at persistence/display boundaries, sentinel tests | Disable companion, preserve evidence without raw secret values, rotate affected credential if exposure is confirmed |
| Dependency supply-chain compromise | Low | High | Supplier/registry/repository/integrity verification, exact pin, lockfile, OSV | Do not download or install if any source check fails |
| Dangerous command escapes policy | Low after sandbox | Critical | No full access, fixed writable root, deny publication/destructive classes, approval relay | Decline and terminate the task; retain worktree for review |
| Executor recursively invokes itself | Medium without isolation | High | Minimal child `CODEX_HOME` with no Gemini MCP registration | Detect recursion marker and fail before starting a nested job |
| GPT and Gemini edit concurrently | Medium | High | Canonical per-repository writer lock | Reject the second writer immediately |
| 9Router stops during streaming | Medium | Medium | Surface a typed failure, propagate cancellation, retain worktree | Restart 9Router and explicitly retry; GPT Plus is unaffected |
| Antigravity authentication or quota fails | Medium | Medium | Preflight model availability and preserve upstream error category | Reconnect/wait; never fall back silently to another provider |
| Child process becomes orphaned | Low after controls | Medium | PID identity, cancellation signal, idle/hard timeout, startup reconciliation | Terminate only the verified child; mark stale job failed |
| Approval cannot be relayed | Medium | High | Treat uncertain approval state as denial | Cancel the turn and return a sanitized failure; never auto-accept |
| Tests overload the machine | Low | Medium | Targeted tests, maximum two workers, one build process | Stop the current test and reduce concurrency |
| Model alias disappears or changes behavior | Medium | Medium | Exact `/v1/models` preflight and fixed allowlist | Fail with `model_unavailable`; require an explicit design update |
| ChatGPT account changes | Low | Low | Separate child auth and `CODEX_HOME`; no Desktop token sharing | Restart Desktop if needed; Gemini configuration remains separate |
| Desktop plugin breaks after an update | Medium | Medium | Supported MCP boundary, installation checkpoint, new-task smoke test | Disable/uninstall through the runbook; no 9Router rollback needed |
| Review enters an infinite loop | Medium | Medium | Hard limit of three review rounds per phase | Close the task after round three and use the CLI profile fallback |

## Three-round Review Policy

Each delivery phase has at most three review rounds:

1. functional correctness and required tests;
2. regression, security, and scope compliance;
3. real integration and recovery behavior.

If round three still fails, there is no fourth review. The change stays isolated,
is not installed or merged, and receives a closure report containing the failed
criterion, evidence, completed portions, and retained paths. The operational
fallback is the existing isolated Gemini CLI profile. The project director then
chooses whether to keep the branch for research or abandon it.

## Git and Upstream Update Strategy

- Commit the stabilized Responses boundary separately from the companion.
- Commit each companion boundary in small, independently testable units.
- Never stage local logs, child runtime state, test worktrees, credentials, or
  unrelated tracked changes.
- Integrate future upstream 9Router changes on a checkpoint branch, then run the
  Responses contract suite, companion offline suite, and production build.
- Because the companion depends only on the public LLM API and App Server
  protocol, ordinary 9Router dashboard/provider changes should not require a
  companion change.
- A breaking change to `/v1/responses`, model naming, or the installed App Server
  protocol requires a compatibility update before promotion.

## Acceptance Criteria

The feature is eligible for installation only when all of the following hold:

- the 9Router production build succeeds;
- the normal dashboard and existing API paths behave the same before and after
  companion installation;
- the root 9Router runtime dependency graph is unchanged;
- the OpenAI/ChatGPT Plus provider remains the Codex Desktop default;
- disabling the companion or stopping 9Router does not prevent GPT Plus work;
- Gemini completes a real read, edit, shell, and test loop through the Codex
  harness in an isolated worktree;
- low, medium, and high effort map consistently and `xhigh` is absent;
- continuation, cancellation, timeout, upstream failure, and stale-process
  recovery are verified;
- no secret, `.env` content, raw credential, or unrelated user change is stored,
  returned, staged, or committed;
- two write jobs cannot target the same repository concurrently;
- no Codex Desktop installed file or main `config.toml` is patched manually;
- disabling or uninstalling the plugin restores the original user experience in
  one documented operation;
- no phase exceeds three review rounds;
- merge, deployment, retained-worktree cleanup, and broader live-provider usage
  remain decisions for the project director.

## Final Scope Boundary

The initial implementation consists of one isolated companion package, three
MCP operations, one child App Server per active Gemini job, and the already
existing 9Router `/v1/responses` endpoint. It adds no Docker requirement, model
picker hook, separate chat UI, dashboard page, monitoring service, or background
scheduler.
