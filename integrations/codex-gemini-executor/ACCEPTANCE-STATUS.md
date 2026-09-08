# Acceptance Status

This is the current consolidation of the chronological evidence in
UPGRADE-SAFETY.md. This document is not a qualified-combination.json record and
must not be used to promote a runtime automatically.

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
