[CmdletBinding()]
param([Parameter(Mandatory)][string]$DescriptorPath, [switch]$Apply)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$requestedApply = $Apply
. (Join-Path $PSScriptRoot 'Set-NineRouterBootstrapSafe.ps1')
$node = 'C:\Program Files\nodejs\node.exe'
$runner = Join-Path $PSScriptRoot 'desktop-approval-canary.mjs'
$authority = 'C:\Users\Admin\.codex\plugins\.plugin-appserver\codex.exe'
$target = 'C:\Users\Admin\.codex\config.toml'

function Assert-CanaryGuard {
    Assert-DesktopClosed
    $d = [IO.File]::ReadAllText($DescriptorPath) | ConvertFrom-Json
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
        if (-not $process.CommandLine) { throw 'process_identity_unavailable' }
        if ($process.CommandLine.Contains($d.root)) { throw 'canary_process_running' }
    }
    $null = & $node $runner --verify $DescriptorPath 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'canary_verification_failed' }
}
function Test-CanaryConfig([string]$Path) {
    $d = [IO.File]::ReadAllText($DescriptorPath) | ConvertFrom-Json
    $oldHome = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = Split-Path -Parent $Path
        # Windows PowerShell treats native stderr warnings as terminating errors.
        # Use separate process streams; neither stream is echoed to the caller.
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $authority
        $info.Arguments = 'mcp get nine-router-gemini-approval-canary --json'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($info)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'authority_timeout' }
        $raw = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        $code = $process.ExitCode
        $process.Dispose()
        if ($code -ne 0) { return $false }
        $m = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
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
        $null = & $node $runner --verify $DescriptorPath 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'canary_verification_failed' }
    }
    $transaction = Join-Path 'C:\Users\Admin\Documents\Codex\codex-portable-capabilities-checkpoints' ('nine-router-approval-' + [guid]::NewGuid().ToString('N'))
    New-PrivateDirectory $transaction
    $profile = Join-Path $transaction 'preview'
    [IO.Directory]::CreateDirectory($profile) | Out-Null
    $proposal = Join-Path $profile 'config.toml'
    $before = Get-ConfigHash $target
    $null = & $node $runner --render $DescriptorPath $target $proposal 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'canary_render_failed' }
    $after = Get-ConfigHash $proposal
    if ((Get-ConfigHash $target) -ne $before) { throw 'config_concurrent_edit' }
    Copy-PreviewCatalog $target $profile
    if (-not (Test-CanaryConfig $proposal)) { throw 'canary_config_invalid' }
    $plan = @{ status = 'PREVIEW_VALIDATED'; descriptorPath = $DescriptorPath; configPath = $target; beforeSha256 = $before; afterSha256 = $after; readiness = 'HOLD' }
    Write-NewBytes (Join-Path $transaction 'plan.json') ([Text.UTF8Encoding]::new($false).GetBytes(($plan | ConvertTo-Json)))
    if ($requestedApply) {
        $checkpoint = Join-Path $transaction 'config.toml.before'
        $result = Invoke-ConfigTransaction -Target $target -Proposal $proposal -Checkpoint $checkpoint `
            -BeforeSha256 $before -AfterSha256 $after -Guard { Assert-CanaryGuard } -Validate { param($p) Test-CanaryConfig $p }
        if ($result -ne 'APPLIED_BOOTSTRAP_ONLY') { throw 'transaction_incomplete' }
        $plan.status = 'APPLIED_FIXTURE_CANARY_ONLY'
        $plan['checkpoint'] = $checkpoint
        Write-NewBytes (Join-Path $transaction 'apply-result.json') ([Text.UTF8Encoding]::new($false).GetBytes(($plan | ConvertTo-Json)))
    }
    $plan['transaction'] = $transaction
    $plan | ConvertTo-Json
} catch {
    $code = $_.Exception.Message
    if ($code -notmatch '^[a-z_]{3,80}$') { $code = 'canary_switch_failed' }
    @{ status = 'HOLD'; error = $code; action = 'Retain checkpoint; do not retry or change routing.' } | ConvertTo-Json -Compress
    exit 1
}
