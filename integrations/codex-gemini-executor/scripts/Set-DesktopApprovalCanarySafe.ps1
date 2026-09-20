[CmdletBinding()]
param([Parameter(Mandatory)][string]$DescriptorPath, [string]$PreviousDescriptorPath, [switch]$Apply)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$requestedApply = $Apply
. (Join-Path $PSScriptRoot 'Set-NineRouterBootstrapSafe.ps1')
$node = 'C:\Program Files\nodejs\node.exe'
$runner = Join-Path $PSScriptRoot 'desktop-approval-canary.mjs'
$authority = 'C:\Users\Admin\.codex\plugins\.plugin-appserver\codex.exe'
$target = 'C:\Users\Admin\.codex\config.toml'
$phase = 'initializing'
$transaction = $null
$checkpoint = $null
$before = $null
$after = $null

function ConvertTo-CanaryNativeArgument([string]$Value) {
    if ($Value -match '[\x00\r\n]') { throw 'native_argument_invalid' }
    # Windows argv quoting: double backslashes before quotes and the closing quote.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
function Invoke-CanaryNative {
    param([string]$Executable, [string[]]$Arguments, [int]$TimeoutMs = 30000)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-CanaryNativeArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            $process.Kill()
            throw 'canary_child_timeout'
        }
        $raw = $stdout.GetAwaiter().GetResult()
        $discarded = $stderr.GetAwaiter().GetResult()
        if ($raw.Length -gt 1MB -or $discarded.Length -gt 1MB) { throw 'canary_child_output_limit' }
        # stderr is drained but never returned, including CLI warnings and secrets.
        return @{ exitCode = $process.ExitCode; stdout = $raw }
    } finally { $process.Dispose() }
}
function Invoke-CanaryVerifier([string[]]$Arguments) {
    $result = Invoke-CanaryNative -Executable $node -Arguments (@($runner) + $Arguments)
    try { $value = $result.stdout | ConvertFrom-Json } catch { throw 'canary_verification_failed' }
    if ($result.exitCode -ne 0 -or $value.status -ne 'pass') {
        $allowed = @('router_identity_unavailable', 'router_identity_mismatch', 'host_identity_changed',
            'node_identity_changed', 'candidate_identity_changed', 'candidate_layout_invalid',
            'release_changed', 'dependencies_changed', 'harness_root_invalid', 'fixture_root_invalid',
            'harness_artifact_invalid', 'harness_artifact_changed', 'harness_artifacts_missing',
            'fixture_link_or_type_invalid', 'fixture_path_alias', 'fixture_layout_invalid',
            'fixture_content_changed', 'canary_runtime_busy', 'canary_job_unfinished',
            'canary_registration_exists', 'scripted_protocol_incomplete', 'metadata_too_large',
            'replacement_must_be_new', 'previous_registration_mismatch')
        if ($value.PSObject.Properties['error'] -and $value.error -in $allowed) { throw $value.error }
        throw 'canary_verification_failed'
    }
}
function Assert-CanaryArtifacts {
    if ($PreviousDescriptorPath) { Invoke-CanaryVerifier @('--verify-replacement', $DescriptorPath, $PreviousDescriptorPath) }
    else { Invoke-CanaryVerifier @('--verify', $DescriptorPath) }
}
function Assert-CanaryGuard {
    $script:phase = 'checking_desktop'
    Assert-DesktopClosed
    $script:phase = 'checking_processes'
    $d = [IO.File]::ReadAllText($DescriptorPath) | ConvertFrom-Json
    $previous = if ($PreviousDescriptorPath) { [IO.File]::ReadAllText($PreviousDescriptorPath) | ConvertFrom-Json } else { $null }
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
        if (-not $process.CommandLine) { throw 'process_identity_unavailable' }
        if ($process.CommandLine.Contains($d.root)) { throw 'canary_process_running' }
        if ($previous -and $process.CommandLine.Contains($previous.root)) { throw 'previous_canary_process_running' }
    }
    $script:phase = 'verifying_canary'
    Assert-CanaryArtifacts
}
function Test-CanaryConfig([string]$Path) {
    $d = [IO.File]::ReadAllText($DescriptorPath) | ConvertFrom-Json
    $oldHome = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = Split-Path -Parent $Path
        $result = Invoke-CanaryNative -Executable $authority -Arguments @('mcp', 'get', 'nine-router-gemini-approval-canary', '--json')
        if ($result.exitCode -ne 0) { return $false }
        $m = $result.stdout | ConvertFrom-Json
        return $m.name -eq 'nine-router-gemini-approval-canary' -and $m.enabled -eq $true -and $null -eq $m.disabled_reason `
            -and $m.transport.command -eq $node -and $m.transport.cwd -eq $d.root `
            -and $m.transport.args.Count -eq 2 -and $m.transport.args[0] -eq (Join-Path $d.root 'desktop-approval-canary.mjs') `
            -and $m.transport.args[1] -eq $DescriptorPath -and $m.startup_timeout_sec -eq 30 -and $m.tool_timeout_sec -eq 300 `
            -and $m.transport.env_vars.Count -eq 1 -and $m.transport.env_vars[0] -eq 'NINEROUTER_API_KEY'
    } finally { $env:CODEX_HOME = $oldHome }
}

function Copy-PreviewCatalog([string]$SourceConfig, [string]$PreviewHome) {
    # The Desktop may use a CODEX_HOME-relative catalog. Copy that one dependency
    # to the private validation profile without changing active config bytes.
    $rootTable = ([IO.File]::ReadAllText($SourceConfig) -split '(?m)^\s*\[', 2)[0]
    $match = [regex]::Match($rootTable, '(?m)^model_catalog_json\s*=\s*["'']([^"''\r\n]+)["'']\s*$')
    if (-not $match.Success) {
        if ($rootTable -match '(?m)^model_catalog_json\s*=') { throw 'preview_catalog_path_unsupported' }
        return
    }
    $catalog = $match.Groups[1].Value
    # IsPathRooted also accepts drive-relative C:foo; require a full drive path.
    if ($catalog -match '^[A-Za-z]:[\\/]' -or $catalog.StartsWith('\\')) { return }
    if ($catalog -notmatch '^[A-Za-z0-9_.-]+\.json$') { throw 'preview_catalog_path_unsupported' }
    $sourcePath = Join-Path (Split-Path -Parent $SourceConfig) $catalog
    $file = Get-Item -LiteralPath $sourcePath
    if ($file.Length -gt 8MB -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'preview_catalog_invalid' }
    Write-NewBytes (Join-Path $PreviewHome $catalog) ([IO.File]::ReadAllBytes($sourcePath))
}
try {
    if ($requestedApply) { Assert-CanaryGuard }
    else {
        $phase = 'verifying_canary'
        Assert-CanaryArtifacts
    }
    $phase = 'creating_preview'
    $transaction = Join-Path 'C:\Users\Admin\Documents\Codex\codex-portable-capabilities-checkpoints' ('nine-router-approval-' + [guid]::NewGuid().ToString('N'))
    New-PrivateDirectory $transaction
    $profile = Join-Path $transaction 'preview'
    [IO.Directory]::CreateDirectory($profile) | Out-Null
    $proposal = Join-Path $profile 'config.toml'
    $before = Get-ConfigHash $target
    $phase = 'rendering_preview'
    if ($PreviousDescriptorPath) {
        Invoke-CanaryVerifier @('--render-replacement', $DescriptorPath, $PreviousDescriptorPath, $target, $proposal)
    } else { Invoke-CanaryVerifier @('--render', $DescriptorPath, $target, $proposal) }
    $after = Get-ConfigHash $proposal
    if ((Get-ConfigHash $target) -ne $before) { throw 'config_concurrent_edit' }
    $phase = 'validating_preview'
    Copy-PreviewCatalog $target $profile
    if (-not (Test-CanaryConfig $proposal)) { throw 'canary_config_invalid' }
    $plan = @{ status = 'PREVIEW_VALIDATED'; descriptorPath = $DescriptorPath; previousDescriptorPath = $PreviousDescriptorPath;
        configPath = $target; beforeSha256 = $before; afterSha256 = $after; readiness = 'HOLD' }
    Write-NewBytes (Join-Path $transaction 'plan.json') ([Text.UTF8Encoding]::new($false).GetBytes(($plan | ConvertTo-Json)))
    if ($requestedApply) {
        $phase = 'applying_config'
        $checkpoint = Join-Path $transaction 'config.toml.before'
        $result = Invoke-ConfigTransaction -Target $target -Proposal $proposal -Checkpoint $checkpoint `
            -BeforeSha256 $before -AfterSha256 $after -Guard { Assert-CanaryGuard } -Validate { param($p) Test-CanaryConfig $p }
        if ($result -ne 'APPLIED_BOOTSTRAP_ONLY') { throw 'transaction_incomplete' }
        $phase = 'saving_result'
        $plan.status = 'APPLIED_FIXTURE_CANARY_ONLY'
        $plan['checkpoint'] = $checkpoint
        Write-NewBytes (Join-Path $transaction 'apply-result.json') ([Text.UTF8Encoding]::new($false).GetBytes(($plan | ConvertTo-Json)))
    }
    $plan['transaction'] = $transaction
    $plan | ConvertTo-Json
} catch {
    $code = $_.Exception.Message
    if ($code -notmatch '^[a-z_]{3,80}$') { $code = 'canary_switch_failed' }
    $configChanged = $false
    if ($checkpoint -and (Test-Path -LiteralPath ($checkpoint + '.displaced'))) {
        $observed = Get-ConfigHash $target
        $configChanged = if ($observed -eq $after) { $true } elseif ($observed -eq $before) { $false } else { $null }
    }
    @{ status = 'HOLD'; error = $code; phase = $phase; configChanged = $configChanged;
        transaction = $transaction; checkpoint = $checkpoint;
        action = 'Retain evidence; diagnose this gate before retrying. Do not change routing.' } | ConvertTo-Json -Compress
    exit 1
}
