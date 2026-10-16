@echo off
rem Shim de goi restart-9router.ps1 tu Explorer/cmd (truyen tham so: -Build, -Status)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-9router.ps1" %*
