# Merge Readiness

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
