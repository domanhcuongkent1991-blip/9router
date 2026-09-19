[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$CandidatePath,
    [string]$ConfigPath = 'C:\Users\Admin\.codex\config.toml',
    [string]$CheckpointRoot = 'C:\Users\Admin\Documents\Codex\codex-portable-capabilities-checkpoints',
    [switch]$Apply,
    [string]$PlanPath,
    [string]$ExpectedPlanSha256,
    [string]$ExpectedConfigSha256,
    [ValidateRange(0, 900)][int]$WaitForDesktopExitSeconds = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$NodePath = 'C:\Program Files\nodejs\node.exe'
$PlannerPath = Join-Path $PSScriptRoot 'bootstrap-switch-plan.mjs'

function Get-BytesHash([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-ConfigHash([string]$Path) { Get-BytesHash ([IO.File]::ReadAllBytes($Path)) }

function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}

function Test-CodexDesktopOpen {
    # Codex Desktop currently uses ChatGPT.exe, not the CLI's codex.exe.
    $processes = @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        try { $path = $process.Path } catch { throw 'desktop_process_identity_unavailable' }
        if ([string]::IsNullOrWhiteSpace($path)) { throw 'desktop_process_identity_unavailable' }
        if ($path -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\' -or $path -match '\\OpenAI\\Codex\\bin\\[^\\]+\\codex\.exe$') { return $true }
    }
    return $false
}

function Assert-DesktopClosed {
    if (Test-CodexDesktopOpen) { throw 'desktop_still_running' }
}

function Assert-NoExecutorProcesses {
    Assert-DesktopClosed
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'codex.exe'")
    foreach ($process in $processes) {
        if (-not $process.ExecutablePath -or -not $process.CommandLine) { throw 'executor_process_identity_unavailable' }
        if ($process.Name -eq 'codex.exe' -or $process.CommandLine -match '9router-gemini-runtime|codex-gemini-executor') { throw 'executor_still_running' }
    }
}

function Invoke-ConfigTransaction {
    param(
        [string]$Target, [string]$Proposal, [string]$Checkpoint,
        [string]$BeforeSha256, [string]$AfterSha256,
        [scriptblock]$Guard, [scriptblock]$Validate
    )
    & $Guard
    $original = [IO.File]::ReadAllBytes($Target)
    $updated = [IO.File]::ReadAllBytes($Proposal)
    if ((Get-BytesHash $original) -ne $BeforeSha256) { throw 'config_concurrent_edit' }
    if ((Get-BytesHash $updated) -ne $AfterSha256) { throw 'proposal_changed' }
    if ((Get-Item -LiteralPath $Target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'config_link_rejected' }
    Write-NewBytes $Checkpoint $original
    $temporary = Join-Path (Split-Path -Parent $Target) ('.nine-router-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $displaced = $Checkpoint + '.displaced'
    $applied = $false
    try {
        Write-NewBytes $temporary $updated
        & $Guard
        if ((Get-ConfigHash $Target) -ne $BeforeSha256) { throw 'config_concurrent_edit' }
        [IO.File]::Replace($temporary, $Target, $displaced, $true)
        $applied = $true
        # Detect a last-moment writer using the bytes actually displaced by Replace.
        if ((Get-ConfigHash $displaced) -ne $BeforeSha256) { throw 'config_concurrent_edit' }
        if ((& $Validate $Target) -ne $true) { throw 'post_validation_failed' }
        if ((Get-ConfigHash $Target) -ne $AfterSha256) { throw 'config_concurrent_edit' }
        return 'APPLIED_BOOTSTRAP_ONLY'
    }
    catch {
        if (-not $applied) { throw }
        if ((Get-ConfigHash $Target) -ne $AfterSha256) { throw 'rollback_refused_concurrent_edit' }
        & $Guard
        $restore = Join-Path (Split-Path -Parent $Target) ('.nine-router-restore-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $failed = $Checkpoint + '.failed-proposal'
        # The displaced file preserves even an edit that raced our final hash check.
        Write-NewBytes $restore ([IO.File]::ReadAllBytes($displaced))
        if ((Get-ConfigHash $Target) -ne $AfterSha256) { throw 'rollback_refused_concurrent_edit' }
        try { [IO.File]::Replace($restore, $Target, $failed, $true) }
        catch { throw 'rollback_failed_checkpoint_retained' }
        if ((Get-ConfigHash $failed) -ne $AfterSha256) { throw 'rollback_race_preserved_in_failed_proposal' }
        throw 'validation_failed_rolled_back'
    }
    finally {
        # Only the unique unused proposal temp can be discarded; checkpoints stay.
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Invoke-Planner([string[]]$Arguments) {
    # Node catches and emits bounded error codes; neither CLI JSON nor stderr leaks.
    $output = & $NodePath $PlannerPath @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'bootstrap_verification_failed' }
    return ($output | ConvertFrom-Json)
}

function New-PrivateDirectory([string]$Path) {
    if (Test-Path -LiteralPath $Path) { throw 'transaction_directory_exists' }
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $identity = [Security.Principal.SecurityIdentifier]::new($sid)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -WhatIf:$false
}

function Invoke-BootstrapSwitch {
    if (-not $Apply -or $WhatIfPreference) {
        if ([string]::IsNullOrWhiteSpace($CandidatePath)) { throw 'candidate_path_required' }
        $transaction = Join-Path $CheckpointRoot ('nine-router-bootstrap-' + [guid]::NewGuid().ToString('N'))
        # -WhatIf previews the active config mutation; private preview artifacts are real.
        New-PrivateDirectory $transaction
        $profile = Join-Path $transaction 'preview-profile'
        [IO.Directory]::CreateDirectory($profile) | Out-Null
        $proposal = Join-Path $profile 'config.toml'
        $plan = Invoke-Planner @($CandidatePath, $ConfigPath, $proposal)
        $savedPlan = Join-Path $transaction 'plan.json'
        Write-NewBytes $savedPlan ([Text.UTF8Encoding]::new($false).GetBytes(($plan | ConvertTo-Json -Depth 10)))
        $null = Invoke-Planner @('--validate', $proposal, $savedPlan)
        [pscustomobject]@{
            status = 'PREVIEW_VALIDATED'; readiness = 'HOLD'; planPath = $savedPlan
            planSha256 = Get-ConfigHash $savedPlan; beforeSha256 = $plan.beforeSha256
            afterSha256 = $plan.afterSha256; releaseId = $plan.releaseId
            appServer = $plan.appServer; credentialPresent = $plan.credentialPresent
            scope = $plan.scope; desktopOpen = Test-CodexDesktopOpen
        } | ConvertTo-Json -Depth 5
        return
    }
    if ($ExpectedPlanSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $ExpectedConfigSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'expected_hashes_required' }
    if ((Get-ConfigHash $PlanPath) -ne $ExpectedPlanSha256) { throw 'plan_changed' }
    $plan = [IO.File]::ReadAllText($PlanPath) | ConvertFrom-Json
    if ($plan.beforeSha256 -ne $ExpectedConfigSha256 -or $plan.configPath -ne $ConfigPath) { throw 'plan_target_mismatch' }
    $transaction = Split-Path -Parent $PlanPath
    $resultPath = Join-Path $transaction 'apply-result.json'
    if (Test-Path -LiteralPath $resultPath) { throw 'transaction_already_attempted' }
    $report = [ordered]@{ status = 'HOLD'; readiness = 'HOLD'; configChanged = $false; checkpoint = $null }
    try {
        if ($WaitForDesktopExitSeconds -gt 0) {
            $deadline = [DateTime]::UtcNow.AddSeconds($WaitForDesktopExitSeconds)
            while (Test-CodexDesktopOpen) {
                if ([DateTime]::UtcNow -ge $deadline) { throw 'desktop_exit_wait_expired' }
                Start-Sleep -Seconds 2
            }
            Start-Sleep -Seconds 2
        }
        Assert-DesktopClosed
        if ((Get-ConfigHash $PlanPath) -ne $ExpectedPlanSha256) { throw 'plan_changed' }
        if ((Get-ConfigHash $ConfigPath) -ne $ExpectedConfigSha256) { throw 'config_concurrent_edit' }
        Assert-NoExecutorProcesses
        $bootedAt = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
        $idle = Invoke-Planner @('--verify-idle', $PlanPath, $bootedAt)
        $report['historicalReadOnlyJobsRetained'] = $idle.previousRuntime.staleJobs
        $null = Invoke-Planner @('--validate', $plan.proposalPath, $PlanPath)
        if (-not $PSCmdlet.ShouldProcess($ConfigPath, 'Apply fixed read-only bootstrap candidate')) { return }
        $checkpoint = Join-Path $transaction 'config.toml.before'
        $report.checkpoint = $checkpoint
        $validate = { param($path) $null = Invoke-Planner @('--validate', $path, $PlanPath); return $true }
        $report.status = Invoke-ConfigTransaction -Target $ConfigPath -Proposal $plan.proposalPath -Checkpoint $checkpoint -BeforeSha256 $plan.beforeSha256 -AfterSha256 $plan.afterSha256 -Guard { Assert-NoExecutorProcesses } -Validate $validate
        $report.configChanged = $true
        $report['releaseId'] = $plan.releaseId
        $report['configSha256'] = Get-ConfigHash $ConfigPath
    }
    catch {
        $code = $_.Exception.Message
        $report['error'] = if ($code -match '^[a-z_]{3,80}$') { $code } else { 'bootstrap_switch_failed' }
        # Do not claim unchanged if rollback refused because another writer intervened.
        $report.configChanged = (Get-ConfigHash $ConfigPath) -ne $ExpectedConfigSha256
    }
    Write-NewBytes $resultPath ([Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 5)))
    $report | ConvertTo-Json -Depth 5
    if ($report.status -ne 'APPLIED_BOOTSTRAP_ONLY') { throw 'bootstrap_switch_hold_see_result' }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-BootstrapSwitch }
    catch { Write-Output 'Bootstrap switch HOLD; inspect the redacted transaction result. No retry is performed.'; exit 1 }
}
