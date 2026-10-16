# 9Router restart tool — non-interactive, reuses the manager's exact
# state files (%TEMP%\9router-manager\9router-production.pid) so the
# interactive manager (start-9router.bat) stays consistent with it.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-9router.ps1            # stop -> start (no build)
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-9router.ps1 -Build     # stop -> npm run build -> start
#   ... restart-9router.ps1 -Status                                                    # state + health only
#
# Stop is gated on PID ownership (pid file + node.exe + StartTime ticks),
# identical to the manager's :stop_mode — it never kills a foreign process.

param(
    [switch]$Build,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$Root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime  = Join-Path $env:TEMP '9router-manager'
$PidFile  = Join-Path $Runtime '9router-production.pid'
$Stdout   = Join-Path $Runtime '9router-production.stdout.log'
$Stderr   = Join-Path $Runtime '9router-production.stderr.log'
$ProdWd   = Join-Path $Root '.next\standalone'
$Port     = 20128

function Write-Step { param($m) Write-Host "[restart] $m" }

function Test-Health {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        return ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true')
    } catch { return $false }
}

function Get-State {
    # 0 = owned & running, 1 = stopped, 2 = port busy (foreign process)
    $trackedPid = 0; $trackedTicks = [int64]0
    try {
        $lines = @(Get-Content -LiteralPath $PidFile -ErrorAction Stop)
        if ($lines.Count -ge 2 -and $lines[0] -match '^\d+$' -and $lines[1] -match '^\d+$') {
            $trackedPid = [int]$lines[0]; $trackedTicks = [int64]$lines[1]
        }
    } catch {}
    $proc = $null
    if ($trackedPid -gt 0) { $proc = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue }
    $listenerLine = netstat -ano | Select-String (':' + $Port + '\s+.*LISTENING') | Select-Object -First 1
    $listenerPid = if ($listenerLine) { [int](($listenerLine.ToString() -split '\s+')[-1]) } else { 0 }
    $owned = $false
    if ($proc -and $proc.Path -and ([IO.Path]::GetFileName($proc.Path) -ieq 'node.exe')) {
        try { $owned = ($proc.StartTime.Ticks -eq $trackedTicks) } catch { $owned = $false }
    }
    if ($owned) { return 0 }
    if ($listenerPid -gt 0) { return 2 }
    return 1
}

function Stop-Managed {
    $state = Get-State
    if ($state -eq 1) { Write-Step 'Server khong chay (hoac khong do launcher quan ly) — bo qua stop.'; return $true }
    if ($state -eq 2) { Write-Step 'LOI: port 20128 do process KHAC giu. Khong tu dong dung — xu ly thu cong.'; return $false }

    $lines = @(Get-Content -LiteralPath $PidFile)
    $targetPid = [int]$lines[0]
    Write-Step "Dang dung process quan ly (pid $targetPid)..."
    taskkill /PID $targetPid /T /F *> $null
    foreach ($i in 1..20) {
        if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { Write-Step 'LOI: khong dung duoc process.'; return $false }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Step 'Da dung.'
    return $true
}

function Start-Managed {
    if (-not (Test-Path (Join-Path $ProdWd 'custom-server.js'))) {
        Write-Step 'LOI: chua co build standalone (.next\standalone\custom-server.js). Chay voi -Build.'
        return $false
    }
    Write-Step 'Dang khoi dong...'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    # custom-server.js -> `next start` reads PORT from env, not from --port argv.
    # Set env in-session (Windows PowerShell 5.1 has no Start-Process -Environment);
    # child inherits these exactly like the interactive manager does.
    $env:PORT = "$Port"; $env:HOSTNAME = '127.0.0.1'; $env:DATA_DIR = "$env:APPDATA\9router"
    $p = Start-Process -FilePath $node `
        -ArgumentList @('custom-server.js') `
        -WorkingDirectory $ProdWd -WindowStyle Hidden `
        -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru
    Start-Sleep -Milliseconds 200
    $startTicks = (Get-Process -Id $p.Id -ErrorAction Stop).StartTime.Ticks
    Set-Content -LiteralPath $PidFile -Value @($p.Id, $startTicks) -Encoding ascii
    Write-Step "Da start, pid $($p.Id). Cho health..."

    foreach ($i in 1..40) {
        if (Test-Health) { Write-Step "Health OK sau $i lan thu: http://127.0.0.1:$Port/api/health"; return $true }
        Start-Sleep -Seconds 1
    }
    Write-Step "LOI: health chua OK sau 40s. Log: $Stderr"
    return $false
}

if ($Status) {
    $state = Get-State
    switch ($state) {
        0 { $h = if (Test-Health) { 'health OK' } else { 'health CHUA OK' }; Write-Host "RUNNING - $h - port $Port" }
        2 { Write-Host "PORT_BUSY - port $Port do process khac giu" }
        default { Write-Host "STOPPED - port $Port" }
    }
    exit 0
}

if (-not (Stop-Managed)) { exit 1 }

if ($Build) {
    Write-Step 'Dang build (npm run build)...'
    & npm run build --prefix $Root
    if ($LASTEXITCODE -ne 0) { Write-Step 'LOI: build that bai — khong start lai voi build cu.'; exit 1 }
    Write-Step 'Build xong.'
}

if (-not (Start-Managed)) { exit 1 }
exit 0
