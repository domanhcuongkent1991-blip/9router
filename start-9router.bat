@echo off
setlocal EnableExtensions DisableDelayedExpansion

title 9Router Manager

rem The manager is intentionally self-contained. It does not change MCP config,
rem provider credentials, or any 9Router source file.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "DATA_DIR=%APPDATA%\9router"
set "DEV_DATA_DIR=%TEMP%\9router-dev-data"
rem Launcher PID/log state is transient and kept outside application data so
rem a locked APPDATA subdirectory cannot prevent startup.
set "RUNTIME_DIR=%TEMP%\9router-manager"

set "PROD_PORT=20128"
set "DEV_PORT=20127"
set "PROD_WD=%ROOT%\.next\standalone"
set "DEV_WD=%ROOT%"

rem Prefer PowerShell 7: Windows PowerShell 5.1 can reject environments that
rem contain both Path and PATH (a common setup on developer machines).
set "PS_EXE=powershell.exe"
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if exist "%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe" set "PS_EXE=%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe"
if exist "C:\Users\Admin\AppData\Local\Programs\PowerShell\7.4.17\pwsh.exe" set "PS_EXE=C:\Users\Admin\AppData\Local\Programs\PowerShell\7.4.17\pwsh.exe"

call :ensure_runtime
if errorlevel 1 (
    rem Some locked-down Windows profiles do not allow a new subdirectory
    rem under APPDATA. Keep only launcher state in TEMP in that case.
    set "RUNTIME_DIR=%TEMP%\9router-manager"
    call :ensure_runtime
    if errorlevel 1 (
        echo.
        echo Khong the tao thu muc runtime: "%RUNTIME_DIR%"
        pause
        exit /b 1
    )
)
call :set_runtime_paths

:menu
cls
echo ==============================================
echo              9Router Manager
echo ==============================================
echo [1] START 9Router + Open Dashboard
echo [2] Check Status
echo [3] Open Dashboard
echo [4] Restart 9Router
echo [5] Stop 9Router
echo [6] DEV Mode :20127
echo [7] Exit Manager
echo.
choice /c 1234567 /n /m "Chon: "

if errorlevel 7 goto :exit_manager
if errorlevel 6 (
    call :start_dev
    goto :menu
)
if errorlevel 5 (
    call :stop_all
    goto :menu
)
if errorlevel 4 (
    call :restart_prod
    goto :menu
)
if errorlevel 3 (
    call :open_dashboard
    goto :menu
)
if errorlevel 2 (
    call :check_status
    goto :menu
)
if errorlevel 1 (
    call :start_prod
    goto :menu
)
goto :menu

:ensure_runtime
if not exist "%RUNTIME_DIR%\" mkdir "%RUNTIME_DIR%" >nul 2>&1
if not exist "%RUNTIME_DIR%\" exit /b 1
exit /b 0

:set_runtime_paths
set "PROD_PID_FILE=%RUNTIME_DIR%\9router-production.pid"
set "DEV_PID_FILE=%RUNTIME_DIR%\9router-dev.pid"
set "PROD_STDOUT=%RUNTIME_DIR%\9router-production.stdout.log"
set "PROD_STDERR=%RUNTIME_DIR%\9router-production.stderr.log"
set "DEV_STDOUT=%RUNTIME_DIR%\9router-dev.stdout.log"
set "DEV_STDERR=%RUNTIME_DIR%\9router-dev.stderr.log"
exit /b 0

:start_prod
echo.
echo [PROD] Kiem tra server port %PROD_PORT%...
if not exist "%PROD_WD%\custom-server.js" (
    echo [PROD] Chua co build standalone.
    echo        Chay: npm run build
    pause
    exit /b 1
)

call :state_code "%PROD_PID_FILE%" "%PROD_PORT%" "prod"
set "STATE_CODE=%ERRORLEVEL%"
if "%STATE_CODE%"=="0" (
    echo [PROD] Da dang chay, khong tao instance thu hai.
    call :wait_health "%PROD_PORT%"
    if not errorlevel 1 call :open_url "http://localhost:%PROD_PORT%/dashboard"
    if errorlevel 1 echo [PROD] Process ton tai nhung health chua OK.
    exit /b 0
)
if "%STATE_CODE%"=="2" (
    echo [PROD] Port %PROD_PORT% dang duoc process khac su dung.
    echo        Khong tu dong dung process khong do launcher quan ly.
    pause
    exit /b 1
)
if exist "%PROD_PID_FILE%" del /q "%PROD_PID_FILE%" >nul 2>&1

echo [PROD] Dang khoi dong nen...
call :launch_prod
if errorlevel 1 (
    echo [PROD] Khoi dong that bai. Xem log: "%PROD_STDERR%"
    pause
    exit /b 1
)

call :wait_health "%PROD_PORT%"
if errorlevel 1 (
    echo [PROD] Health chua OK sau thoi gian cho.
    echo        Xem log: "%PROD_STDERR%"
    pause
    exit /b 1
)

echo [PROD] Health OK: http://localhost:%PROD_PORT%/api/health
call :open_url "http://localhost:%PROD_PORT%/dashboard"
echo [PROD] Dashboard da duoc mo.
pause
exit /b 0

:launch_prod
set "PS_WD=%PROD_WD%"
set "PS_DATA_DIR=%DATA_DIR%"
set "PS_PID_PATH=%PROD_PID_FILE%"
set "PS_STDOUT=%PROD_STDOUT%"
set "PS_STDERR=%PROD_STDERR%"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $node=(Get-Command node.exe -ErrorAction Stop).Source; $env:DATA_DIR=$env:PS_DATA_DIR; $env:HOSTNAME='127.0.0.1'; $env:PORT='20128'; $p=Start-Process -FilePath $node -ArgumentList @('custom-server.js','--port','20128') -WorkingDirectory $env:PS_WD -WindowStyle Hidden -RedirectStandardOutput $env:PS_STDOUT -RedirectStandardError $env:PS_STDERR -PassThru; Start-Sleep -Milliseconds 200; $startTicks=(Get-Process -Id $p.Id -ErrorAction Stop).StartTime.Ticks; Set-Content -LiteralPath $env:PS_PID_PATH -Value @($p.Id,$startTicks) -Encoding ascii"
exit /b %ERRORLEVEL%

:start_dev
echo.
echo [DEV] Kiem tra server port %DEV_PORT%...
call :state_code "%DEV_PID_FILE%" "%DEV_PORT%" "dev"
set "STATE_CODE=%ERRORLEVEL%"
if "%STATE_CODE%"=="0" (
    echo [DEV] Da dang chay, khong tao instance thu hai.
    echo       http://localhost:%DEV_PORT%
    pause
    exit /b 0
)
if "%STATE_CODE%"=="2" (
    echo [DEV] Port %DEV_PORT% dang duoc process khac su dung.
    echo       Khong tu dong dung process khong do launcher quan ly.
    pause
    exit /b 1
)
if exist "%DEV_PID_FILE%" del /q "%DEV_PID_FILE%" >nul 2>&1

echo [DEV] Dang khoi dong nen...
call :launch_dev
if errorlevel 1 (
    echo [DEV] Khoi dong that bai. Xem log: "%DEV_STDERR%"
    pause
    exit /b 1
)
echo [DEV] Da khoi dong: http://localhost:%DEV_PORT%
pause
exit /b 0

:launch_dev
set "PS_WD=%DEV_WD%"
set "PS_DATA_DIR=%DEV_DATA_DIR%"
set "PS_PID_PATH=%DEV_PID_FILE%"
set "PS_STDOUT=%DEV_STDOUT%"
set "PS_STDERR=%DEV_STDERR%"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $node=(Get-Command node.exe -ErrorAction Stop).Source; $env:DATA_DIR=$env:PS_DATA_DIR; $env:HOSTNAME='127.0.0.1'; $p=Start-Process -FilePath $node -ArgumentList @('node_modules\next\dist\bin\next','dev','--port','20127') -WorkingDirectory $env:PS_WD -WindowStyle Hidden -RedirectStandardOutput $env:PS_STDOUT -RedirectStandardError $env:PS_STDERR -PassThru; Start-Sleep -Milliseconds 200; $startTicks=(Get-Process -Id $p.Id -ErrorAction Stop).StartTime.Ticks; Set-Content -LiteralPath $env:PS_PID_PATH -Value @($p.Id,$startTicks) -Encoding ascii"
exit /b %ERRORLEVEL%

:restart_prod
echo.
echo [PROD] Dang restart...
call :stop_mode prod
call :start_prod
exit /b %ERRORLEVEL%

:stop_all
echo.
call :stop_mode prod
call :stop_mode dev
pause
exit /b 0

:stop_mode
set "STOP_MODE=%~1"
if /i "%STOP_MODE%"=="prod" (
    set "STOP_PID_FILE=%PROD_PID_FILE%"
    set "STOP_PORT=%PROD_PORT%"
) else (
    set "STOP_PID_FILE=%DEV_PID_FILE%"
    set "STOP_PORT=%DEV_PORT%"
)

call :state_code "%STOP_PID_FILE%" "%STOP_PORT%" "%STOP_MODE%"
set "STATE_CODE=%ERRORLEVEL%"
if "%STATE_CODE%"=="1" (
    if exist "%STOP_PID_FILE%" del /q "%STOP_PID_FILE%" >nul 2>&1
    echo [%STOP_MODE%] Khong co process do launcher quan ly.
    exit /b 0
)
if "%STATE_CODE%"=="2" (
    echo [%STOP_MODE%] Port %STOP_PORT% dang bi process khac su dung; khong dung.
    exit /b 1
)
if not "%STATE_CODE%"=="0" (
    echo [%STOP_MODE%] Khong xac minh duoc process; khong dung.
    exit /b 1
)

set "PS_PID_PATH=%STOP_PID_FILE%"
set "PS_PORT=%STOP_PORT%"
set "PS_MODE=%STOP_MODE%"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$path=$env:PS_PID_PATH; $lines=@(Get-Content -LiteralPath $path -ErrorAction Stop); $trackedPid=[int]$lines[0]; $trackedTicks=[int64]$lines[1]; $proc=Get-Process -Id $trackedPid -ErrorAction SilentlyContinue; $owned=$false; if($proc -and $proc.Path -and ([IO.Path]::GetFileName($proc.Path) -ieq 'node.exe')){try{$owned=($proc.StartTime.Ticks -eq $trackedTicks)}catch{$owned=$false}}; if(-not $owned){ if($proc){exit 2}; Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue; exit 0 }; taskkill /PID $trackedPid /T /F *> $null; foreach($i in 1..20){ if(-not (Get-Process -Id $trackedPid -ErrorAction SilentlyContinue)){break}; Start-Sleep -Milliseconds 250 }; if(Get-Process -Id $trackedPid -ErrorAction SilentlyContinue){exit 1}; Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue; exit 0"
if errorlevel 1 (
    echo [%STOP_MODE%] Khong dung duoc process da xac minh.
    exit /b 1
)
echo [%STOP_MODE%] Da dung process do launcher quan ly.
exit /b 0

:check_status
echo.
call :show_status prod "%PROD_PID_FILE%" "%PROD_PORT%"
call :show_status dev "%DEV_PID_FILE%" "%DEV_PORT%"
echo.
pause
exit /b 0

:show_status
set "SHOW_MODE=%~1"
set "SHOW_PID_FILE=%~2"
set "SHOW_PORT=%~3"
call :state_code "%SHOW_PID_FILE%" "%SHOW_PORT%" "%SHOW_MODE%"
set "STATE_CODE=%ERRORLEVEL%"
if "%STATE_CODE%"=="0" (
    call :health_once "%SHOW_PORT%"
    if errorlevel 1 (
        echo [%SHOW_MODE%] RUNNING - health chua OK - port %SHOW_PORT%
    ) else (
        echo [%SHOW_MODE%] RUNNING - health OK - port %SHOW_PORT%
    )
    exit /b 0
)
if "%STATE_CODE%"=="2" (
    echo [%SHOW_MODE%] PORT_BUSY - port %SHOW_PORT% khong do launcher quan ly
    exit /b 0
)
echo [%SHOW_MODE%] STOPPED - port %SHOW_PORT%
exit /b 0

:state_code
set "PS_PID_PATH=%~1"
set "PS_PORT=%~2"
set "PS_MODE=%~3"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$path=$env:PS_PID_PATH; $port=[int]$env:PS_PORT; $trackedPid=0; $trackedTicks=0; try{$lines=@(Get-Content -LiteralPath $path -ErrorAction Stop); if($lines.Count -ge 2 -and $lines[0] -match '^\d+$' -and $lines[1] -match '^\d+$'){$trackedPid=[int]$lines[0];$trackedTicks=[int64]$lines[1]}}catch{}; $proc=$null; if($trackedPid -gt 0){$proc=Get-Process -Id $trackedPid -ErrorAction SilentlyContinue}; $listenerLine=netstat -ano | Select-String (':' + $port + '\s+.*LISTENING') | Select-Object -First 1; $listenerPid=if($listenerLine){[int](($listenerLine.ToString() -split '\s+')[-1])}else{0}; $owned=$false; if($proc -and $proc.Path -and ([IO.Path]::GetFileName($proc.Path) -ieq 'node.exe')){try{$owned=($proc.StartTime.Ticks -eq $trackedTicks)}catch{$owned=$false}}; if($owned){exit 0}; if($listenerPid -gt 0){exit 2}; exit 1"
exit /b %ERRORLEVEL%

:health_once
set "PS_HEALTH_URL=http://127.0.0.1:%~1/api/health"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "try{$r=Invoke-WebRequest -UseBasicParsing -Uri $env:PS_HEALTH_URL -TimeoutSec 2; if($r.StatusCode -eq 200 -and $r.Content -match '\"ok\"\s*:\s*true'){exit 0}}catch{}; exit 1"
exit /b %ERRORLEVEL%

:wait_health
for /l %%I in (1,1,20) do (
    call :health_once "%~1"
    if not errorlevel 1 exit /b 0
    timeout /t 1 /nobreak >nul
)
exit /b 1

:open_dashboard
call :open_url "http://localhost:%PROD_PORT%/dashboard"
echo.
echo Da mo Dashboard: http://localhost:%PROD_PORT%/dashboard
pause
exit /b 0

:open_url
set "PS_OPEN_URL=%~1"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:PS_OPEN_URL"
exit /b %ERRORLEVEL%

:exit_manager
echo.
echo Dong menu. Server dang chay se duoc giu nguyen.
exit /b 0
