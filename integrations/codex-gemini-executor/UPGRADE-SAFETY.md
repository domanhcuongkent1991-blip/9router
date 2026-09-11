# Upgrade Safety

Current consolidated decision and remaining gates: [ACCEPTANCE-STATUS.md](ACCEPTANCE-STATUS.md).
Verification sections below are chronological; later evidence supersedes earlier
not-run or failed statuses only within the scope explicitly tested.

Approved scope: preserve the source checkout and installed Desktop configuration.
No runtime, dependency, model or provider upgrades are performed by this change.

## Implementation

- [x] Qualify consumed schema values and nested payloads, not just primitive types.
- [x] Require explicit qualification of the installed runtime combination before new jobs.
- [x] Exclude concurrent companion owners and writers across processes; never guess stale ownership.
- [x] Preserve session/worktree identity on resume and reject unknown or mismatched sessions.
- [x] Propagate cancellation, bound cleanup, and quarantine unconfirmed shutdown.
- [x] Prevent unqualified one-click 9Router upgrades and stop migration on backup failure.
- [x] Run focused regressions and one final companion suite.

## Release Acceptance

Record the exact Desktop host, configured app-server path/version/SHA-256,
companion source digest, Node path/version, 9Router build digest, model/provider,
data schema and profile. A version number alone is not a qualification.
Candidate checks must be isolated from production state and run without changing
the active registration. No automatic fallback to PATH, another model or provider.

Before promotion: pass protocol qualification and live read-only, status, cancel,
resume, approval accept/decline, multi-turn tool and stream-disconnect checks.
Write tests use a disposable repository, never the user's source checkout.
Re-observe candidate identities before activation. Do not activate while jobs run.

Upgrade one component at a time. Keep the last qualified companion and 9Router
artifacts, plus a verified data backup outside automatic backup retention.
Test restoration against an isolated data copy before changing the live service.
Never restore over data written after the checkpoint without explicit consent.
An unexpected update blocks new jobs; status/cancel remain available when the
transport is healthy. Disabled MCP is not a rollback of completed side effects.

Current upstream candidate observed on 2026-09-07: 9Router 0.5.69, Git commit
eb712ca821f0ba6bc41043fbd14494c5af5daba5. Its source lacks this companion and the
local Responses boundary. Preserve the local patches when integrating it.
Metadata inspection is not a live compatibility qualification.

Keep MCP optional. Resolve Node by an explicit path. Set host tool timeout above
the job hard deadline plus startup/persistence/cleanup allowance (e.g. 7500s for
120-minute jobs). Optional startup grace must be tested in the actual Desktop
host; CLI mcp get under a sandbox is not proof of Desktop profile selection.

## Operating the New Source

This worktree is NOT installed. The old registered companion has not changed.
Do not point Desktop at this worktree until candidate acceptance is complete.
The existing 9Router installation lacks the new `/api/compatibility` contract;
the new companion intentionally refuses jobs against it. That refusal is not
evidence of an upstream protocol defect.

`node src/qualification-cli.js observe` prints a credential-free evidence template
with all checks false. `node src/qualification-cli.js promote C:\\absolute\\evidence.json`
validates operator-supplied evidence, re-observes runtime identities, acquires the
execution lock, preserves the previous record and atomically writes the new one.
It does NOT perform or attest live checks on the operator's behalf. Do not mark
checks true without retained evidence. Neither command changes Codex config.
Candidate acceptance must use the adapter directly in isolated fixtures, not a
production qualification bypass. An automated live-canary runner is not included.

### Model Selection and Error Observability

`NINEROUTER_GEMINI_MODEL` remains the required default model.
`NINEROUTER_GEMINI_MODELS`, when present, is a semicolon-separated allowlist of
one to 64 unique safe model identifiers and must include that default. The sorted
allowlist and fixed `nine_router` provider are part of the qualification identity;
changing either requires fresh evidence. A request may select only an allowlisted
model. The resolved model is bound to its child config, App Server session,
approval continuation and saved session metadata. There is no model/provider
failover or extra quota retry.

The companion retains only bounded structured remote `source`, `status`, and
`code` metadata for classification; it never stores remote response bodies. It
distinguishes `codex_account`, `mcp_execution`, `router`, `provider`, `model`, and
`unknown` when the emitting layer identifies itself. An HTTP 429 without that
structured layer evidence remains `protocol_error` from `unknown`, never a claim
that the provider is out of quota. If the MCP host rejects a tool invocation
before the companion starts, the companion has no result to classify and must not
invent one.

The new gate binds app-server path/version/hash, Node path/version, companion
source digest, dependency lock digest, 9Router version/BUILD_ID/contract and model.
The BUILD_ID is captured by the running server module; serving unbuilt dev code
fails closed. This assumes immutable release files. Desktop host identity,
profile and database restoration remain operator-verified release criteria:
the companion cannot independently attest which Desktop process hosts MCP.
Updating CLI alone does not invalidate a combination it does not execute.

The execution-owner lock is deliberately global to this runtime, including
read-only jobs. Concurrent jobs receive workspace_locked rather than queueing.
Both state discovery and status reads preserve nonterminal records from other
instances. Cancel an active job through its owning instance. Following a crash,
do not remove execution-owner.json merely because its PID is absent: first
inspect the instance/PID/start time, confirm all owned processes are stopped and
preserve its worktree/state. Retain the lock when ownership cannot be verified.
Legacy sessions without an exact session/worktree/runtime binding cannot resume.
No session is automatically replayed after uncertain execution.

Windows children run suspended until assigned to a kill-on-close Job Object.
Normal wrapper exit waits for all descendants; forced wrapper termination is
reported as unconfirmed and keeps the owner lock. There remains a very small
creation-before-assignment interval in which forced wrapper termination can
leave a suspended (never executed) child; do not claim atomic process creation.

The migration gate requires backup success, not a verified restore rehearsal.
After a database initialization failure, correct the cause and restart the
server; the existing database driver caches initialization failure in-process.

## Verification (2026-09-07)

- Companion: 192/192, concurrency 1; includes two real Windows process-tree tests.
- 9Router scoped tests: 29/29 (update route, backup gate, build identity, dashboard guard).
- Existing saved app-server canonical schema: compatible with all five methods.
- Production build and standalone asset packaging passed using Node 24.12.0 and
  Next.js 16.3.4, with one worker, two CPU affinity and a 3 GB heap limit.
  BUILD_ID: `odkrMPhssCvAQ8iK6tQU7` (9Router 0.5.65).
- The root dependency junction caused cross-drive webpack resolution failure.
  Build succeeded after copying existing dependencies locally. No npm install or
  package upgrade was performed. The retained `node_modules.shared` junction was
  later moved to the task scratch directory to prevent accidental staging.
  The original D:\\9Router dependency tree was only read.
- Google Fonts access was approved. Windows Defender custom scan of the bundled
  static media directory completed with exit code 0; this is not a security guarantee.
- Real app-server protocol canary passed against codex-cli 0.153.4, SHA-256
  `e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75`;
  process cleanup was confirmed. No model request was made.
- Standalone API canary passed on loopback port 20128 with fresh isolated data:
  health OK; compatibility version/BUILD_ID/contract matched with no-store;
  invalid JSON and missing input returned 400; unauthenticated update returned 401.
  The HTTP canary does not establish the authenticated update route's 409 result.
  The owned server was stopped and the listener was confirmed closed.
- Build database initialization used node:sqlite because better-sqlite3 native
  bindings were unavailable. Requalify the selected database driver on Node upgrades.
  Standalone emitted an existing module-type warning from backgroundTokenRefresh;
  background token refresh was disabled for this canary.
- Credentialed live model canary attempted after the operator connected a test
  Antigravity OAuth account. Connection was active. An unauthenticated API probe
  returned 401; a subsequent probe using a temporary candidate API key reached
  antigravity/gemini-3.8-flash and received upstream HTTP 403. The Responses
  boundary returned 500/dispatch_failed, with no CANARY_OK output. The temporary
  key was revoked in finally. No credential values are retained in this report.
  The account/model entitlement versus provider compatibility cause is unresolved;
  do not infer it from successful OAuth login. Do not retry-loop or change models
  silently. This is a failed live canary, not a compatibility pass.
- No installation, registration change or promotion performed. Browser UI checks
  and app-server model execution/resume/cancel/approval workflows remain untested.
  Temporary protocol evidence and server logs are under
  C:\\tmp\\CodexScratch\\2026-09-07-mcp-upgrade-canary.
- No project-local Gitleaks scanner available; secret-scan coverage is limited.
- Release gates still pending: live model canary, verified backup
  restoration, Desktop profile/tool/optional-startup checks and controlled activation.

### Live App-Server Follow-Up After OAuth Reauthentication

The operator reauthenticated the isolated Antigravity connection. Fresh canaries
against the same 0.5.65 BUILD_ID and app-server 0.153.4 hash above passed:
- Read-only text turn: expected marker returned with assistant delta and completion.
- Resume in a new app-server process: previous marker recalled in the same thread.
- Cancellation after turn start: terminal cancelled result observed.
- Child cleanup confirmed for each turn; temporary API key revoked and absence checked.

Evidence: `C:\tmp\CodexScratch\2026-09-07-mcp-upgrade-canary\live-appserver-report.json`.
These results supersede the earlier failed OAuth-era live text canary, not the
remaining Desktop host, restore or promotion criteria.

The tool-read probe remains unqualified. Its initial temporary runner sanitizer
failed on nullable approval fields; the adapter cancelled and cleaned up. After
fixing that runner, command approval reached the decision callback, was declined
by its exact-command allowlist, and the turn completed normally. Do not count
execution lifecycle events alone as proof that a command executed successfully.
No broad approval was granted. Approval acceptance, successful tool execution,
stream disconnect recovery and actual Desktop MCP elicitation remain pending.
No production source, registration or qualified runtime was changed.

### Tool Replay Fix

The approval allowlist mismatch was traced to the bundled PowerShell path under
the Codex primary runtime, not an incorrect execution workspace. The temporary
runner now accepts only the observed exact marker-read command in the fixture.
Approval acceptance executed the command with exit 0 and the expected marker.
The subsequent model request exposed a separate local Responses validation bug:
Codex replays reasoning with `content: null`; the boundary rejected it with 400
at `input[3].content`. Normalize that nullable content to absence, while retaining
validation of other invalid types and preserving the original input.

Regression was observed failing before the fix. Afterwards 44/44 scoped tests
passed (request boundary, handler boundary, multi-turn and nullable reasoning).
Production build and standalone packaging passed; new BUILD_ID is
`G8BL4KsQa-2SXQcL1QbGy`. Earlier canary evidence belongs to the prior BUILD_ID.
Fresh `live-tool-report.json` confirms approval acceptance, execution activity,
completed execution and the expected final marker on this new build; cleanup and
temporary-key revocation were confirmed. The previous tool-read failure is resolved.
Fresh `live-disconnect-report.json` confirms an SSE chunk was received before
client abort, followed by a successful new app-server text turn. This verifies
continued service after client disconnect, not upstream cancellation completion
or recovery of the interrupted turn. Those stronger claims remain unqualified.

An isolated SQLite backup was restored to a separate file and passed integrity
check with matching provider-connection count. Artifacts are under
`C:\tmp\CodexScratch\2026-09-07-mcp-upgrade-canary\restore-1788789230622`.
This verifies SQLite backup/readability, not the application's migration-backup
implementation or full application restore. Test OAuth data remains local there.

### Separate Candidate Storage

Optional installation-owned environment settings now select storage locations:
- `NINEROUTER_RUNTIME_ROOT`: jobs, child CODEX_HOME, sessions, execution-owner lock
  and qualified-combination record. Default remains the existing runtime directory.
- `NINEROUTER_WORKTREE_ROOT`: generated schemas and disposable job worktrees.
  Default remains the existing CodexScratch job directory.

Both require local drive-qualified directories, not a drive root or overlapping
parent/child paths. The qualification CLI uses the same configured runtime root.
Use physically separate directories with no junction/symlink aliases to production;
lexical validation does not prove filesystem isolation or protect against another
local process changing directory links. Runtime isolation does not replace the
permitted-workspace allowlist. Keep the candidate allowlist limited to its fixture.

24/24 scoped installation/state/workspace/upgrade tests passed, including two
instances reading and writing only their selected job/qualification paths.
Companion source identity changed; old qualification evidence must not be promoted
unchanged. No Desktop MCP registration was added and no live config was modified.

### Desktop Discovery and Negative Execution Check

The separate discovery-only registration `nine-router-gemini-canary` was later
added by the operator with a config checkpoint. Desktop task tool discovery
confirmed run_gemini_task, get_gemini_status and cancel_gemini_task.
Direct Desktop calls now confirm:
- With the candidate server unavailable, execution fails at router identity.
- With build `G8BL4KsQa-2SXQcL1QbGy` online, execution fails at qualification
  with `qualification_record_missing` (job_89beda03-269b-4df1-bd36-2606737803bd).
- Status returns the same terminal failure. No child config or qualification
  record exists and the execution-owner lock is absent after cleanup.
No model execution or Desktop approval was exercised in these negative checks.
The generic displayed version-error message is not a reliable root-cause label;
use the structured stage/reason to distinguish router outages and missing approval.

Desktop approval testing must not fabricate a production qualification record.
Proposed next step: a separate fixture-only canary runner using the existing MCP
bridge and app-server adapter, with a fixed marker-read task, bounded deadline,
read-only access, explicit operator approval, temporary candidate credentials and
exact runtime identity checks. It must not accept arbitrary tasks/workspaces or
be counted as production-core qualification. This runner is not implemented yet.
