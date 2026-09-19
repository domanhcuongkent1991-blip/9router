$ErrorActionPreference = 'Stop'
$root = $env:NINEROUTER_TEST_SCRATCH_ROOT
if (-not $root) { throw 'test_environment_blocked' }
$fixture = Join-Path $root ('bootstrap-external-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$wrapper = Join-Path $fixture 'Complete-NineRouterBootstrap.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\scripts\Complete-NineRouterBootstrap.ps1') -Destination $wrapper
# The stand-in is only in this fixture directory. It cannot touch the active profile.
$writer = @'
param([string]$CandidatePath, [switch]$Apply, [string]$PlanPath, [string]$ExpectedPlanSha256, [string]$ExpectedConfigSha256)
function Assert-NoExecutorProcesses { }
if ($MyInvocation.InvocationName -eq '.') { return }
if ($Apply) {
    if ($ExpectedPlanSha256 -ne ('a' * 64) -or $ExpectedConfigSha256 -ne ('b' * 64)) { exit 1 }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'applied.txt'), $PlanPath)
    if (Test-Path (Join-Path $PSScriptRoot 'fail-apply')) { exit 1 }
    @{status='APPLIED_BOOTSTRAP_ONLY'} | ConvertTo-Json
} else {
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'candidate.txt'), $CandidatePath)
    if (Test-Path (Join-Path $PSScriptRoot 'fail-preview')) { exit 1 }
    @{status='PREVIEW_VALIDATED';desktopOpen=$false;planPath=(Join-Path $PSScriptRoot 'plan.json');planSha256=('a' * 64);beforeSha256=('b' * 64)} | ConvertTo-Json
}
'@
[IO.File]::WriteAllText((Join-Path $fixture 'Set-NineRouterBootstrapSafe.ps1'), $writer)
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$candidate = Join-Path $fixture 'candidate with spaces'
$applied = Join-Path $fixture 'applied.txt'
$null = & $ps -NoProfile -ExecutionPolicy Bypass -File $wrapper -CandidatePath $candidate
if ($LASTEXITCODE -ne 0 -or (Test-Path $applied)) { throw 'preview_applied_or_failed' }
if ([IO.File]::ReadAllText((Join-Path $fixture 'candidate.txt')) -cne $candidate) { throw 'candidate_argument_lost' }
$null = & $ps -NoProfile -ExecutionPolicy Bypass -File $wrapper -CandidatePath $candidate -Apply
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $applied)) { throw 'apply_flag_lost' }
if ([IO.File]::ReadAllText($applied) -cne (Join-Path $fixture 'plan.json')) { throw 'plan_argument_lost' }
Remove-Item -LiteralPath $applied
[IO.File]::WriteAllText((Join-Path $fixture 'fail-preview'), 'fixture')
$null = & $ps -NoProfile -ExecutionPolicy Bypass -File $wrapper -CandidatePath $candidate -Apply
if ($LASTEXITCODE -eq 0 -or (Test-Path $applied)) { throw 'preview_failure_did_not_stop' }
Remove-Item -LiteralPath (Join-Path $fixture 'fail-preview')
[IO.File]::WriteAllText((Join-Path $fixture 'fail-apply'), 'fixture')
$null = & $ps -NoProfile -ExecutionPolicy Bypass -File $wrapper -CandidatePath $candidate -Apply
if ($LASTEXITCODE -eq 0) { throw 'apply_failure_reported_success' }
@{passed=4;failed=0} | ConvertTo-Json -Compress
