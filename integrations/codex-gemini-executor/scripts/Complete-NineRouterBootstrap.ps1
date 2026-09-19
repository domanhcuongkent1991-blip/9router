[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidatePath,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-ExternalBootstrap {
    # Launch from an external Windows PowerShell window after exiting Desktop.
    # Do not use a Codex child process as the coordinator across Desktop shutdown.
    $requestedCandidatePath = $CandidatePath
    $requestedApply = $Apply
    $writer = Join-Path $PSScriptRoot 'Set-NineRouterBootstrapSafe.ps1'
    . $writer
    Assert-NoExecutorProcesses
    $powershellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $output = & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $writer -CandidatePath $requestedCandidatePath
    if ($LASTEXITCODE -ne 0) { throw 'bootstrap_preview_failed' }
    $preview = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($preview.status -ne 'PREVIEW_VALIDATED' -or $preview.desktopOpen) { throw 'desktop_must_be_closed_before_preview' }
    $preview | ConvertTo-Json -Depth 5
    if (-not $requestedApply) { return }
    # All routing/runtime checks run again in the writer; no retry or hash rebasing.
    $output = & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $writer -Apply -PlanPath $preview.planPath -ExpectedPlanSha256 $preview.planSha256 -ExpectedConfigSha256 $preview.beforeSha256
    $code = $LASTEXITCODE
    $output | Write-Output
    if ($code -ne 0) { throw 'bootstrap_apply_failed' }
    Write-Output 'APPLIED_BOOTSTRAP_ONLY: Open Codex Desktop once, then verify a new task. General readiness remains HOLD.'
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-ExternalBootstrap }
    catch {
        $code = $_.Exception.Message
        if ($code -notmatch '^[a-z_]{3,80}$') { $code = 'external_bootstrap_failed' }
        [ordered]@{ status = 'HOLD'; error = $code; action = 'Stop and retain the transaction evidence. Do not retry or change routing.' } | ConvertTo-Json -Compress
        exit 1
    }
}
