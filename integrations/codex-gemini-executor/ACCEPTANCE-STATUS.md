# Acceptance Status

This is the current consolidation of the chronological evidence in
UPGRADE-SAFETY.md. This document is not a qualified-combination.json record and
must not be used to promote a runtime automatically.

## Current candidate status (2026-09-20)

**Desktop bootstrap canary PASS; general qualification and Ready for use remain HOLD.**
Provider/model remain `nine_router` / `ag/gemini-3.8-flash`.
Router is `0.5.81`, BUILD_ID `hzoyTQX0BWYc2RS2-Vf50`; Node is
`C:\Program Files\nodejs\node.exe`, `v24.12.0`.

Candidate: `C:\Users\Admin\Documents\Codex\9router-gemini-runtime\candidates\candidate-cbce1116-48b7-46a0-84c6-06039289075d`.
Release: `03b8dcf1a4a5`; source digest:
`9890f487645f30ab24fe71cc37cb394d06baa173fbb97c68a89bfd73e769ee01`.

- Snapshot offline suite: **347/347**, no skips; log retained in
  `C:\tmp\CodexScratch\2026-09-19-mcp-stability\candidate-cbce1116-offline.log`.
- Live candidate canary passed read-only, write accept, write decline,
  cancellation, restart status and cleanup. Approval decisions were scripted,
  not Desktop UI decisions.
- Candidate stdio report passed initialize, exactly three tools, fixed bootstrap
  read-only task, status, terminal cancel, status after a new process and clean
  shutdown. Bootstrap evidence grants only the fixed marker task.
- Safe writer applied the candidate atomically after Desktop exit. Transaction
  checkpoint:
  `C:\Users\Admin\Documents\Codex\codex-portable-capabilities-checkpoints\nine-router-bootstrap-d6ae4404d9374c45bfe09fdef2c9b4c6\config.toml.before`.
  The active entry now uses `package/src/index.js`, the isolated bootstrap runtime,
  and the fixed read-only workspace; `required=false` remains unchanged.
- A fresh Desktop task called the active MCP candidate successfully. Job
  `job_45970381-64aa-4c07-ae6a-f735ab09bc7e` completed the fixed marker read with
  output `21 bytes`, model `ag/gemini-3.8-flash`, `filesChanged=[]`, and
  `recoveryRequired=false`. Status after completion and terminal cancel were
  idempotent. The bootstrap runtime owner was released and all persisted jobs are
  terminal.
- Final host evidence matched App Server `codex-cli 0.155.0-alpha.9.2` with SHA-256
  `bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226`.
- Post-restart profile diagnosis confirmed the running Desktop App Server is
  owned by `Admin`, with no explicit `--profile`. Its executable at
  `C:\Users\Admin\AppData\Local\OpenAI\Codex\bin\247581e40ee272fb\codex.exe`
  has the same version and SHA-256 as the fixed plugin App Server authority.
  The shell runs as `CodexSandboxOffline`, whose Windows profile directory is
  `C:\Users\CodexSandboxOffline`, despite `USERPROFILE=C:\Users\Admin`.
  With `CODEX_HOME` unset, authority `mcp get` reports no server; setting it only
  for the probe to `C:\Users\Admin\.codex` returns the exact candidate entrypoint
  and bootstrap runtime. This is a shell configuration-context mismatch, not a
  missing Desktop registration. The running process environment was not read.
- The actual Desktop MCP status tool re-read the completed canary job above after
  restart, returning the same `21 bytes` answer, canonical model and
  `filesChanged=[]`. No new model call or configuration change was needed for
  this diagnosis. Current preflight passes all config, credential-presence,
  scratch, router and release identity checks; it correctly remains HOLD with
  `qualification_record_missing` and `qualification_stale` because the general
  scoped-combination record is absent.
- Requalification checks on 2026-09-20 used the dedicated scratch root
  `C:\tmp\CodexScratch\2026-09-20-mcp-stability`; create/delete probe passed and
  the candidate offline suite remained **347/347**. Project-local Gitleaks passed
  on the immutable candidate package. OSV coverage remains limited because the
  repository does not contain the pinned `osv-scanner.exe`.
- The configured router had stopped before the recheck; no listener owned port
  `20128`. The exact `D:\9Router\.next\standalone\custom-server.js` build was
  started with the existing local data root, and `/api/health` plus
  `/api/compatibility` returned the expected router identity. Preflight then
  passed endpoint, scratch, credential-presence, router and release checks; only
  `qualification_record_missing` and `qualification_stale` remained.
- A new Desktop fixed read-only canary completed as job
  `job_2b05c04a-4456-4257-8440-c05834a6efcf`, returning `21 bytes`,
  `filesChanged=[]`, `recoveryRequired=false`, and the canonical model. A
  workspace-write probe against the active bootstrap registration returned a
  sanitized `protocol_error`. Subsequent read-only request-validation diagnosis
  found the fixture lacked `canary-input.txt`: `scope_denied/path_unavailable`
  was flattened to the public `protocol_error`. It failed before qualification,
  model dispatch or approval. This is NOT evidence of a Desktop elicitation defect.
- A separate fixture-only `scoped-canary-cli` accept attempt on 2026-09-20
  returned the bounded `protocol_error` result and wrote no qualification record.
  Its scope required `canary-output`, which had not been prepared; offline
  validation reproduced `scope_denied/path_unavailable`. It did not test approval
  or model execution and does not replace the earlier scripted live-canary report.
  The pure qualification check also rejects `bootstrap-evidence.json` with
  `scoped_combination_not_qualified`, so no general record was created.
- A fixture-only Desktop approval harness now imports the unchanged immutable
  candidate core, broker and MCP bridge. It accepts only four exact requests
  (accept, decline, cancel, timeout), confines each to one prepared marker file,
  verifies the exact write hash/text fingerprint before asking for approval,
  and refuses replay or advancing after a failed scenario. It never writes a
  general qualification record. Candidate release/source/lock/dependency bytes,
  router identity, Node and App Server authority hash are checked again.
- Harness artifact:
  `C:\Users\Admin\Documents\Codex\9router-gemini-runtime\approval-canaries\8804bed8-db89-4358-ac55-7c89afdad552`.
  `scripted-protocol.json` passes all four scenarios on protocol `2025-11-25`;
  each requested one approval. Cleanup, terminal cancel, persisted status in a
  fresh companion and file hashes passed. The timeout used the real one-minute
  job deadline and rejected a late continuation. `recovery.result.json` passes
  wrong-hash refusal, backup restore and journal verification on the scripted
  fixture only. `desktopAcceptance` remains **false**.
- Two earlier harness attempts are retained under `approval-canaries` for
  diagnosis: `8a10ef15-*` used an incorrectly negotiated test client;
  `5c394386-*` passed all core scenarios but the client did not handle the expected
  stale-continuation rejection after timeout. Neither report is a passing gate.
- Working-tree offline suite with harness tests: **365/365**, no skips; log:
  `C:\tmp\CodexScratch\2026-09-20-mcp-stability\approval-harness-verified-offline.log`. The
  immutable candidate's previous **347/347** is a separate suite. Focused
  Gitleaks passed for harness scripts/tests; OSV coverage remains limited.
- Corrected source writer `scripts/Set-DesktopApprovalCanarySafe.ps1` preview
  passed App Server validation in checkpoint transaction
  `nine-router-approval-d0c41cb314d54e748659b3e029f74400`. It appends an optional
  `nine-router-gemini-approval-canary` registration and leaves the existing MCP
  entry byte-for-byte intact. The preview supplies the relative model catalog
  in its private profile and reads native stdout/stderr separately. Apply has
  **not** run. Use the corrected source writer, not the earlier copy bundled
  under the harness artifact. See MCP-OPERATIONS.md for the exact external command.
- Fixed two real wire defects: recovery fields missing from the strict MCP
  output schema and internal `scoped-edit` leaking into public MCP output.
- Qualification policy v2 binds release location, endpoint, provider and model
  allowlist. Old policy v1 records cannot be promoted unchanged.

The active Desktop registration now points to the verified candidate and the
fixed read-only bootstrap task is attested. The bootstrap record is deliberately
not a general qualification record. Approval accept/decline/cancel through the
real Desktop elicitation UI, optional startup behavior for a new task, and the
full workspace-write qualification remain pending. Do not use the MCP for general
delegated work until those gates have their own evidence. OSV coverage is limited
because the project-local scanner is absent; no dependencies were installed or
changed.

See [MCP-OPERATIONS.md](MCP-OPERATIONS.md) for commands and update boundaries.

## Historical MCP Remediation Status (2026-09-12)

Offline source verification is current: checkout HEAD is
`9b9ce0877de1b28c118698aa6f1f7bd976f4b73d`, `npm test` is **242/242**, and the
qualified source digest still matches the companion source. The canonical
identity is provider `nine_router`, model `ag/gemini-3.8-flash`, Codex
`0.154.0-alpha.6.2`, and Node `v24.12.0` at
`C:\Program Files\nodejs\node.exe`.

MCP Desktop activation is **HOLD** pending an Admin-host preflight that proves
`NINEROUTER_API_KEY` is present without exposing its value; the atomic config
update with `env_vars`, fixed Node path and bounded host timeouts is complete.
A fresh
Desktop task showing `initialize` plus exactly the three companion tools.
The MCP remains optional; CLI profile overrides and fixture canaries are not
Desktop activation evidence. Existing canary and qualification records below
are historical/operator-scoped evidence and must not be reused as fresh host
proof.

The fixed-Node stdio preflight passed `initialize` and `tools/list` with exactly
the three companion tools. A missing-key negative probe remained bounded and
did not expose credential text; this is process-level evidence, not Desktop
task evidence.

## Historical qualification round (2026-09-12; superseded for MCP activation)

**Activated identity:** codex `0.154.0-alpha.6.2` (SHA-256 `081e4de4be8e38fa...`)
via the promotion snapshot
`C:\Users\Admin\Documents\Codex\9router-gemini-runtime\qualified\appserver-081e4de4be8e\`;
router BUILD_ID `krXwLgOMmky4REVYzKWjP`; companion source = the D:\9Router
working tree (structured commandActions forwarding, session-resume
extensibility fix, Responses adapter spec compliance). Promotion record
written at `C:\Users\Admin\Documents\Codex\9router-gemini-runtime\qualified-combination.json`
(13/13 canary checks).

- 11/13 checks from the Stage A/B/C harness (`C:\tmp\CodexScratch\2026-09-11-gemini-live-002c61ad-v1\harness\`,
  durable copy in the runtime root `qualification-harness\`); desktop canary
  5/5 turns (accept/resume/decline/cancel/approval-timeout) executed as
  **operator-delegated scripted canary** — the elicitation decisions were made
  by the canary runner per user instruction, not by clicking the Desktop UI.
- `desktopOptionalStartup` is verified as: on-demand executor startup plus the
  approval host deadline (8s) producing a clean `approval_timeout` with
  confirmed cleanup. If the original intended semantics differ, re-run.
- Session-resume root cause fixed in the product: the frozen validated request
  could not carry `resumeContext` (strict-mode TypeError); `core.js` now keeps
  an extensible copy. Codex `thread/resume` itself was exonerated by probe.
- Responses wire fix: `response.completed` must be emitted at finish_reason —
  deferring to flush races `createDisconnectAwareStream`'s disconnect synthesis
  and drops the terminal ("stream closed before response.completed"). Guarded
  by `tests/unit/disconnect-aware-terminal.test.js`.
- Re-qualification workflow for future codex updates: edit `baseline.mjs` in
  the harness (2 lines: version + sha, paths), run `stage-c-qualification.mjs`,
  re-run the desktop canary, rewrite the record. The activated deployment runs
  the frozen snapshot, so upstream updates do not disturb it.

## Decision

Source merge preparation is separate from runtime activation. See
[MERGE-READINESS.md](MERGE-READINESS.md) for the final source-test results and scope.

Fixture-only Desktop canary work is complete for approval accept, decline and
cancel. Production activation remains on hold. Do not repeat these UI tests
unless their bridge, host or runtime identity changes materially.

## Evidence

| Check | Evidence and scope |
| --- | --- |
| Desktop tool discovery | Terra reported all three tools in the actual task registry; this task also called the canary tools directly. |
| Desktop acceptance | Operator explicitly confirmed UI approval. Job `job_f7c41b0b-6a80-41ad-9468-4e6ec7437f92` completed, read CANARY_7429, filesChanged empty, read-only fixture, no worktree. Result supplied in this conversation. |
| Desktop decline and cancel | Operator reports both succeeded. No job IDs or raw results supplied; record as operator-attested, not independently inspected. |
| Fail-closed qualification | Direct Desktop call failed with qualification_record_missing; status agreed; child config absent and owner lock released. |
| App-server text/resume/cancel | Direct runner evidence on earlier router BUILD_ID; not proof of installed companion session-store resume. |
| Tool round trip | Fresh live-tool-report.json on BUILD_ID G8BL4KsQa-2SXQcL1QbGy passed after nullable reasoning fix. |
| Stream disconnect | Client aborted SSE after receiving a chunk; next app-server turn succeeded. Upstream cancellation and interrupted-turn recovery were not attested. |
| Backup readability | Separate SQLite backup/restored file passed integrity check and connection-count match. Not an application restore or migration-backup rehearsal. |
| Tests/build | Prior recorded runs: 192 companion tests, 29 router safety tests; later 44 Responses tests and 24 scoped storage tests passed. These are different runs, not one final suite of the latest source. Build passed on Node 24.12.0 / Next 16.3.4. |

## Identity Boundaries

- Tested router: 0.5.65, latest built candidate G8BL4KsQa-2SXQcL1QbGy.
- Configured Desktop app-server: codex-cli 0.153.4, SHA-256
  e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75.
- Node: v24.12.0. Build selected node:sqlite because better-sqlite3 bindings
  were unavailable; database driver changes require requalification.
- Desktop approval runner is separate from createInstalledGeminiCompanion.
  It reuses the bridge, core and adapter but does not prove production installation,
  persisted recovery, arbitrary workspace access or qualified execution.
- Companion source changed after early canaries; recalculate source/lock digests
  and bind final evidence to the exact candidate before promotion.
- CodexSandboxOffline and Admin have different MCP profiles. Use Admin for the
  saved Desktop configuration and actual task tools for host discovery evidence.
- Upstream 9Router 0.5.69 was observed earlier, not integrated or qualified.
  Do not label this candidate as an upstream upgrade or current latest release.

## Minimum Remaining Work Before Activation

1. Reconcile qualification evidence against the final installed candidate identity.
   Keep desktopOptionalStartup false until actual optional startup behavior and
   host timeout configuration are verified. Successful startup is not that test.
2. Exercise the application's real backup/restore path in isolation, preserving
   the required data and verifying the application opens it successfully.
3. Confirm status/resume and cleanup using the installed companion wiring in an
   isolated runtime. Existing adapter-only resume is narrower evidence.
4. Establish a retained prior runtime artifact, data checkpoint, and explicit
   activation/rollback targets. Production registration, credentials or data must
   not be switched without a separate activation decision.

Do not manufacture all-true checks to escape a qualification dependency. Tests
can use isolated adapters as documented; promotion still requires retained,
scope-appropriate evidence. No broad audit or repeated UI approval run is needed.

## Operational Notes

The canary server is temporary and may stop when its launching session or Desktop
exits. Verify loopback port 20128 and BUILD_ID before interpreting setup errors.
No autostart/service was installed. Temporary test credentials and SQLite copies
remain sensitive even though they are not production data.

No production activation, upstream installation, commit or push was performed.
Project-local security scanner coverage remains limited as previously recorded.
