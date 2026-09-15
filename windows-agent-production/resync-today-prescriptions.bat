@echo off
setlocal
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" goto POWERSHELL_NOT_FOUND

set "AGENT_PS=%~dp0PharmFarm-Agent.ps1"
if not exist "%AGENT_PS%" set "AGENT_PS=%ProgramData%\PharmFarmAgent\PharmFarm-Agent.ps1"
if not exist "%AGENT_PS%" goto AGENT_NOT_FOUND

echo This explicit test sync overwrites previously imported prescription lines.
echo Use the tray resync action to safely pause a running agent. This command refuses concurrent execution.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%AGENT_PS%" -Console -ResyncTodayPrescriptions -ConfigPath "%ProgramData%\PharmFarmAgent\agent.config.json"
set "AGENT_EXIT=%ERRORLEVEL%"
pause
exit /b %AGENT_EXIT%

:AGENT_NOT_FOUND
echo PharmFarm-Agent.ps1 was not found.
echo Run install-pharmfarm-agent.bat first, or keep this file next to PharmFarm-Agent.ps1.
pause
exit /b 1

:POWERSHELL_NOT_FOUND
echo Windows PowerShell was not found.
echo Check: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
pause
exit /b 1
