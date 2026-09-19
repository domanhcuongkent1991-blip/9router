[CmdletBinding()]
param(
    [string]$ConfigPath = 'C:\Users\Admin\.codex\config.toml',
    [string]$QualificationPath = '',
    [string]$TestScratchRoot = $(if ($env:NINEROUTER_TEST_SCRATCH_ROOT) { $env:NINEROUTER_TEST_SCRATCH_ROOT } else { 'C:\tmp\CodexScratch' })
)

$ErrorActionPreference = 'Stop'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$scriptPath = Join-Path $PSScriptRoot 'preflight-mcp.mjs'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    Write-Output '{"status":"config_invalid","pass":false,"failures":[{"code":"config_invalid","detail":"fixed_node_missing"}]}'
    exit 1
}
$arguments = @($scriptPath, "--config=$ConfigPath", "--scratch=$TestScratchRoot")
if ($QualificationPath) { $arguments += "--qualification=$QualificationPath" }
& $nodePath @arguments
exit $LASTEXITCODE
