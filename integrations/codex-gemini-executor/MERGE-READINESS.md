# Merge Readiness

## Current MCP Remediation Status (2026-09-12)

The companion source is offline-ready after the test-discovery repair, but
Desktop MCP activation remains gated on the Admin-host credential, optional
startup, fixed Node path and real `initialize`/`tools/list` evidence. The
canonical model is `ag/gemini-3.8-flash`; bare `gemini-3.8-flash` is rejected.
The MCP must remain optional and must not be promoted from CLI profile output.

Current verification:

- Checkout HEAD: `9b9ce0877de1b28c118698aa6f1f7bd976f4b73d`.
- `npm test`: **242/242**, after limiting discovery to `test/*.test.js`;
  fixture `test/fixtures/windows-job-parent.cjs` is not an independent test.
- Current qualified identity: Codex `0.154.0-alpha.6.2`, Node `v24.12.0`
  at `C:/Program Files/nodejs/node.exe`, provider `nine_router`, model
  `ag/gemini-3.8-flash`; source digest matches the qualification record.
- Admin MCP configuration was updated atomically with a checkpoint to forward
  `NINEROUTER_API_KEY` through `env_vars`, use the fixed Node path, and set
  host timeouts while retaining the optional MCP policy. The checkpoint is
  retained for rollback.
- Fixed-Node stdio preflight passed `initialize` and `tools/list` with exactly
  `run_gemini_task`, `get_gemini_status`, and `cancel_gemini_task`; a missing-key
  negative probe exited with a bounded message and no credential text.
- No live Gemini call, Desktop handshake, activation, promotion, commit or
  push is attested by this status.

The following review is retained as historical evidence only.

## Historical Companion Review (2026-09-11)

This section supersedes the historical source-readiness, branch and scanner
statements below **only for the current companion change**. Historical runtime
evidence is retained, not re-attested. This report records pre-commit acceptance;
the owner subsequently authorized a local commit conditional on all scoped
checks passing. Push, branch merge and activation are not authorized here.

### Decision and exact scope

The companion's reviewed source and offline regression checks pass. No remaining
blocking correctness finding was identified in this review's scope. The owner
approved project-local Gitleaks installation and its fresh changed-file scan
passed on all 29 candidate files, including the new classifier and tests.
The source candidate is ready for the authorized local commit, subject to
final staged-path/content and unchanged-identity checks. This is not production
activation, full-history scanning or application-wide security certification.

Current checkout: `D:/9Router`, branch `master`, HEAD
`8aa9e7bc7593f8326eff9840059d753bcdd0e2b6`. Candidate changes are uncommitted,
not a separate finished branch awaiting merge. Select only this integration's
source, tests and documentation when preparing the eventual commit. In
particular, `src/error-classification.js` and `test/error-classification.test.js`
are new untracked files and must be included with their consumers.

Unrelated `next.config.mjs`, `start-9router.bat`, `.codex-profile-test/`, and
`.next-backup-*` entries were left untouched and are not part of this acceptance.
The app's root build/dependencies are not being qualified by this review.

### Review result and additional repairs

The project agent's R8-R10 candidate was independently checked at source digest
`2c05157f0a2ac98ea768a622783309678cceae88ddd6f9471ea9e6a723f05ebd`; its full
suite passed 233/233. The review confirmed:

- R8: useful terminal metadata survives empty completion metadata, useful
  completion metadata wins as a whole, and retryable-only evidence does not
  become a fabricated terminal quota cause.
- R9: future error strings/objects/turn kinds and incompatible TurnError union
  branches fail qualification. Captured canonical schema mutations were made
  only in memory; the on-disk fixture was not changed.
- R10: real local session/runtime diagnostic stage/reason survives core,
  persisted/recovered status and MCP without allowing arbitrary metadata.

Three additional regressions were found and fixed locally with failing tests
observed before implementation:

1. Missing nested `required` arrays raised TypeError rather than returning
   incompatibility. Required consumed fields now fail closed without throwing.
2. An equivalent HTTP status `integer|null` represented with anyOf/oneOf was
   rejected. Every alternative is now checked; integer/null alternatives and
   local refs pass while number/string/object alternatives remain rejected.
3. Old persisted `provider_quota_exceeded` records degraded to protocol_error.
   The one renamed legacy category now maps to quota_exceeded/provider without
   carrying old free-form payloads or rewriting records. Read, reconcile,
   restarted core and MCP status retain the normalized meaning.

These repairs changed only `src/app-server/schema-qualification.js`,
`src/error-classification.js` and their nearest schema/state regression tests.
No retry, provider, model allowlist, workspace, approval, ownership or runtime
registration policy was relaxed.

### Fresh verification after final source changes

All listed executable checks completed with exit 0:

- `npm test`: **236/236**, no failures, cancellations or skips; concurrency 2.
  Includes real Windows process-tree cleanup, model selection, workspace gates,
  approval, cancellation, timeout, recovery and redaction regressions.
- Focused schema/adapter/installation: **52/52**.
- Focused state/error-classification/MCP: **30/30**.
- Unchanged fixture-only `policy.test.mjs`: **2/2**. This proves the policy
  assertions, not live Desktop canary execution or arbitrary workspace access.
- Canonical schema diagnostic: original accepted, five incompatible mutations
  rejected without exceptions, two equivalent HTTP-status unions accepted.
- `node --check`: **51** source/test JavaScript files passed.
- Scoped `git -c core.safecrlf=false diff --check`: passed.
- Quick codebase health: the existing PowerShell helper passed PSScriptAnalyzer
  with zero errors/warnings. Overall WARNING because duplication was deliberately
  skipped in Quick mode; no Pester tests applicable. Large-file metrics are
  informational and did not trigger unrelated refactoring.

Reproduction commands from `D:/9Router/integrations/codex-gemini-executor`:

```powershell
node --test test/schema-qualification.test.js test/adapter.test.js test/installation.test.js
node --test test/state-store.test.js test/error-classification.test.js test/mcp-bridge.test.js
npm test
node --test C:/Users/Admin/Documents/Codex/9router-desktop-canary/policy.test.mjs
git -c core.safecrlf=false diff --check -- .
node --input-type=module -e "import {sourceDigest} from './src/qualification.js'; console.log(await sourceDigest('./src'));"
Get-FileHash -LiteralPath package-lock.json -Algorithm SHA256
```

Final identity:

- Node: `C:/Program Files/nodejs/node.exe`, `v24.12.0`.
- Source SHA-256: `8ddcd0a1af691dfdfe2ae26781eb9d0186c23180f38dc96ba602b33560abaf9a`.
- Test-tree SHA-256: `0f4c99d577f2bb8e2b098ebd040c2a3d94fe52c052c865c5eebeee8c14be8a9a`.
- Lock SHA-256: `43588d5996984c5920e1129e56aee1cc3d29ad5d3788e296dac008d1fb3cb703`.
- Companion package.json and package-lock.json remain unchanged against HEAD.

### Remaining limits before integration or activation

- Gitleaks 8.30.1 was installed project-locally after explicit approval, without
  changing PATH, project dependencies or Codex/MCP configuration. Official release:
  https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1.
  Archive SHA-256 `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`
  matches both GitHub asset metadata and the release checksum file. Executable
  SHA-256 `17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c`
  matches the project's scanner pin. Windows Defender custom scan completed
  with no matching detections (signature 1.459.55.0); this is not a safety guarantee.
- The unchanged `scripts/ai-security-secrets.ps1` scanned an isolated local
  checkout containing exactly the 29 reviewed candidate files. Gitleaks returned
  pass/exit 0 with no findings, using full redaction and ignoring inline allow
  annotations. Root backup/profile/config changes were excluded. Initial report:
  `C:/tmp/CodexScratch/2026-09-07-mcp-security-tools/secrets-37b7cf59ddb24c9d8f56864c941116fd/gitleaks.json`.
  A final scan after this documentation update is retained at
  `C:/tmp/CodexScratch/2026-09-11-gemini-merge-gitleaks/final-gitleaks.json`.
  Scanner binaries, temporary checkout and reports remain local and must not
  be staged. The local strict-profile file is absent; this report does not
  assert an unavailable strict Framework certification.
- No project dependency changes or installation occurred; there is no new OSV scan or
  broader application dependency-security claim in this handoff.
- Live model calls, installed-companion qualification, promotion and Desktop
  registration were not exercised. Source digest changed; old source-bound
  qualification evidence must not be reused unchanged.
- The fixture runner imports a different retained companion tree. Its policy
  tests are intentionally not proof of adopting this checkout's runtime.
- No ACL repair, user-data cleanup, push, branch merge or runtime activation
  is part of this acceptance. Commit authorization is local and scoped only
  to the reviewed companion candidate.

## Historical Evidence (Earlier Candidates)

## Final Integration Update (2026-09-08)

The owner selected proportionate security for this personal project. Monaco is
pinned to 0.56.0 and the installed top-level DOMPurify now matches the 3.4.13
override. A root npm lockfile is retained for reproducible installation.
Gitleaks changed-file scan and OSV lockfile scan passed. OSV does not inspect
Monaco's vendored DOMPurify 3.4.8 or the translator's existing CDN loader; these
remain explicitly unremediated runtime risks, not a claimed comprehensive XSS fix.
The previously proposed local Monaco bundling change was not implemented.

The nullable reasoning fix now preserves content:null, matching the owner's
existing source change and regression tests in the target checkout. Earlier
notes about deleting that property are historical and superseded.
Source integration is permitted; production runtime promotion remains separate.

## Current Security Gate

Commit/merge is pending the dependency security decision below; the earlier
source-test readiness does not mean all security gates passed.

Gitleaks 8.30.1 and OSV Scanner 2.5.1 are now installed project-locally, verified
against GitHub release SHA-256 metadata and scanned with Windows Defender.
Gitleaks scanned the changed-file snapshot: pass, no findings (39 files at that
run). OSV scan: fail, 18 advisories for dompurify 3.2.7 in the installed app
inventory. No findings were reported for the test/companion lockfiles.

Monaco Editor 0.55.1 pins dompurify 3.2.7. The original D:\9Router inventory has
the same versions and package.json is unchanged, so this is a pre-existing
dependency risk, not introduced by this patch. That does not make it harmless
or justify marking OSV pass. Root package-lock.json is absent; app coverage uses
node_modules/.package-lock.json and does not establish reproducible resolution.
The advisory set contains fixes through 3.4.13; dependency remediation requires
a deliberate package update and verification of editor behavior/build.

OSV evidence: C:\tmp\CodexScratch\2026-09-07-mcp-security-tools\deps-a7285036118f4a09813fb93c31ca6313\osv.json.
Local scanner scripts check pinned binary hashes and keep reports outside Git.
No scanner binary, API key or OAuth data should be staged.

The target master checkout also contains an uncommitted nullable-reasoning fix
and its test. It accepts null without removing the property; this patch normalizes
null to absence. Preserve the user's other edits and tests during integration;
do not overwrite or blindly stash the checkout. No commit or merge has occurred.

## Scope

The source change is prepared for merge review. This is not production activation
or permission to promote a qualified runtime. Keep D:\9Router unchanged until the
integration operation is explicitly selected; the working branch is
codex/mcp-upgrade-safety. No commit, push or merge was performed.

## Changes

- Fail-closed runtime identity and consumed-schema qualification.
- Cross-process execution ownership with quarantine on uncertain cleanup.
- Session/worktree binding and non-destructive persisted job discovery.
- Host cancellation propagation and Windows child-tree cleanup.
- Optional separate runtime/worktree roots, also used by qualification CLI.
- Production build identity endpoint; no credentials or registry lookup.
- One-click update returns 409/manual_upgrade_required without restarting.
- Schema migration aborts if its required backup fails.
- Nullable reasoning content accepted on Codex tool-result replay; malformed
  non-null values still rejected.
- Router identity and qualification errors no longer claim a Codex version issue.

## Final Verification

- Full companion suite on final source: 196 passed, 0 failed, concurrency 1.
  Includes actual Windows process-tree cleanup tests.
- Router regression selection: 106 passed, 0 failed across 15 files covering
  Responses normalization/stream terminal behavior, endpoint boundaries, update
  protection, migration backup gate, compatibility identity and dashboard guard.
- git diff --check passed; Git emits only existing LF/CRLF conversion notices.
- Router production build and standalone canary passed earlier with BUILD_ID
  G8BL4KsQa-2SXQcL1QbGy. No router runtime source changed since that build; subsequent
  changes are companion code/tests and documentation. No redundant build run.
- Desktop acceptance/decline/cancel evidence is recorded in ACCEPTANCE-STATUS.md.
  It exercises a separate fixture runner, not production installation qualification.

Tests were run with existing dependencies, without npm install or dependency
upgrades. Heavy processes were limited to two CPUs and BelowNormal priority.
The full unrelated router test suite was not run. Gitleaks/OSV project-local
tooling is absent: scanner coverage is limited, not a security pass. No strict
project scanner profile was found. Do not claim release security certification.

## Integration Notes

Stage only the companion source/tests/docs, the Responses request fix/test,
compatibility endpoint/test, update route/test, migration/test and dashboard guard
listed by git status. Temporary runners, credentials, database copies, build
output and node_modules are not part of this change. The unused dependency
junction was moved to the task scratch directory without changing its target.

Important behavior changes: unqualified installations refuse new jobs; legacy
sessions without binding cannot resume; uncertain owner locks need manual
recovery; one-click router upgrades are disabled. Merging the source does not
copy evidence records, update Desktop registration or automatically enable jobs.

## Deployment-Only Gates

Before enabling this code in production, finish the exact-runtime evidence,
Desktop optional startup/timeout verification, actual application backup restore,
and installed-companion status/resume qualification listed in ACCEPTANCE-STATUS.md.
These are activation conditions, not a reason to repeat completed source tests.
Never fabricate all-true qualification evidence to complete them.

Known documented limits remain: static path validation cannot prevent external
junction substitution, Windows suspended process creation is not atomic with Job
Object assignment, and BUILD_ID qualification assumes immutable release files.
Changes to Node/database driver, Desktop host, executed app-server or upstream
9Router require their own isolated qualification before activation.
