# 9Router production smoke test — run after any build/restart/rollback.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-prod.ps1 [-ExpectedVersion 0.5.95] [-BaseUrl http://localhost:20128]
# Exit code 0 = all checks pass; 1 = at least one check failed.
# Read-only: performs GET requests only, changes nothing.
param(
    [string]$ExpectedVersion = "",
    [string]$BaseUrl = "http://localhost:20128"
)

$ErrorActionPreference = "Stop"
$results = @()
$failed = $false

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $script:results += [pscustomobject]@{ Check = $Name; Ok = $Ok; Detail = $Detail }
    if (-not $Ok) { $script:failed = $true }
}

# 1. /api/health — server alive
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -Method Get -TimeoutSec 10
    Add-Check "health" ([bool]$health.ok) ($health | ConvertTo-Json -Compress)
} catch {
    Add-Check "health" $false "request failed: $($_.Exception.Message)"
}

# 2. /api/compatibility — version + buildId
try {
    $compat = Invoke-RestMethod -Uri "$BaseUrl/api/compatibility" -Method Get -TimeoutSec 10
    $versionOk = $true
    $detail = "version=$($compat.version) buildId=$($compat.buildId)"
    if ($ExpectedVersion -ne "" -and $compat.version -ne $ExpectedVersion) {
        $versionOk = $false
        $detail += " (expected $ExpectedVersion)"
    }
    Add-Check "compatibility" $versionOk $detail
} catch {
    Add-Check "compatibility" $false "request failed: $($_.Exception.Message)"
}

# 3. /dashboard — UI served
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/dashboard" -Method Get -TimeoutSec 15 -UseBasicParsing
    Add-Check "dashboard" ($resp.StatusCode -eq 200) "HTTP $($resp.StatusCode)"
} catch {
    Add-Check "dashboard" $false "request failed: $($_.Exception.Message)"
}

# 4. /api/models — model catalog API
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/models" -Method Get -TimeoutSec 15 -UseBasicParsing
    Add-Check "models" ($resp.StatusCode -eq 200) "HTTP $($resp.StatusCode)"
} catch {
    Add-Check "models" $false "request failed: $($_.Exception.Message)"
}

$results | Format-Table -AutoSize | Out-String | Write-Host
if ($failed) {
    Write-Host "SMOKE FAIL"; exit 1
}
Write-Host "SMOKE PASS"; exit 0
