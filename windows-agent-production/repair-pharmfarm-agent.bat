@echo off
setlocal
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" goto POWERSHELL_NOT_FOUND
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0PharmFarm-AgentRepair.ps1"
set "REPAIR_EXIT=%ERRORLEVEL%"
pause
exit /b %REPAIR_EXIT%

:POWERSHELL_NOT_FOUND
echo Windows PowerShell was not found.
pause
exit /b 1
