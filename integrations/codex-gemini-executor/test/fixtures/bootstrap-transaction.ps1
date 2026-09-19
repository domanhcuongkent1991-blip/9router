$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\Set-NineRouterBootstrapSafe.ps1')
$root = $env:NINEROUTER_TEST_SCRATCH_ROOT
if (-not $root) { throw 'test_environment_blocked' }
$fixture = Join-Path $root ('bootstrap-transaction-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$passed = 0
function Assert-Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw 'fixture_assertion_failed' } }
function Run-Fixture([string]$Case) {
    $directory = Join-Path $fixture $Case
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $target = Join-Path $directory 'config.toml'
    $proposal = Join-Path $directory 'proposal.toml'
    $checkpoint = Join-Path $directory 'before.toml'
    [IO.File]::WriteAllText($target, 'original')
    [IO.File]::WriteAllText($proposal, 'proposal')
    $before = Get-ConfigHash $target
    $after = Get-ConfigHash $proposal
    $guard = { }
    $validation = { $true }
    switch ($Case) {
        'rollback' { $validation = { $false } }
        'concurrent-before' { [IO.File]::WriteAllText($target, 'external') }
        'concurrent-after' { $validation = { param($path) [IO.File]::WriteAllText($path, 'external'); $false } }
        'desktop-open' { $guard = { throw 'desktop_still_running' } }
        'proposal-drift' { [IO.File]::WriteAllText($proposal, 'changed') }
        'checkpoint-exists' { [IO.File]::WriteAllText($checkpoint, 'retained') }
    }
    $code = $null
    try { $result = Invoke-ConfigTransaction -Target $target -Proposal $proposal -Checkpoint $checkpoint -BeforeSha256 $before -AfterSha256 $after -Guard $guard -Validate $validation }
    catch { $code = $_.Exception.Message }
    switch ($Case) {
        'success' {
            Assert-Equal $result 'APPLIED_BOOTSTRAP_ONLY'
            Assert-Equal ([IO.File]::ReadAllText($target)) 'proposal'
            Assert-Equal ([IO.File]::ReadAllText($checkpoint)) 'original'
        }
        'rollback' { Assert-Equal $code 'validation_failed_rolled_back'; Assert-Equal ([IO.File]::ReadAllText($target)) 'original' }
        'concurrent-before' { Assert-Equal $code 'config_concurrent_edit'; Assert-Equal ([IO.File]::ReadAllText($target)) 'external' }
        'concurrent-after' { Assert-Equal $code 'rollback_refused_concurrent_edit'; Assert-Equal ([IO.File]::ReadAllText($target)) 'external'; Assert-Equal ([IO.File]::ReadAllText($checkpoint)) 'original' }
        'desktop-open' { Assert-Equal $code 'desktop_still_running'; Assert-Equal ([IO.File]::ReadAllText($target)) 'original'; Assert-Equal (Test-Path $checkpoint) $false }
        'proposal-drift' { Assert-Equal $code 'proposal_changed'; Assert-Equal ([IO.File]::ReadAllText($target)) 'original' }
        'checkpoint-exists' { if (-not $code) { throw 'checkpoint_overwritten' }; Assert-Equal ([IO.File]::ReadAllText($checkpoint)) 'retained'; Assert-Equal ([IO.File]::ReadAllText($target)) 'original' }
    }
}
foreach ($case in @('success', 'rollback', 'concurrent-before', 'concurrent-after', 'desktop-open', 'proposal-drift', 'checkpoint-exists')) { Run-Fixture $case; $passed++ }
@{ passed = $passed; failed = 0 } | ConvertTo-Json -Compress
