@echo off
setlocal
pushd "%~dp0"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" goto POWERSHELL_NOT_FOUND

echo PharmFarm debug export will write local CSV files only.
echo WARNING: exported CSV files may contain sensitive prescription or patient-related data.
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0debug-export-last-month-csv.ps1" -Server ".\EPHARM_DB" -Days 31 -MaxRowsPerTable 2000
pause
exit /b %ERRORLEVEL%

:POWERSHELL_NOT_FOUND
echo Windows PowerShell was not found.
echo Check: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
pause
exit /b 1
