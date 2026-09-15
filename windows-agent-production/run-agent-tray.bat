@echo off
setlocal
set "AGENT_HOST=%ProgramData%\PharmFarmAgent\PharmFarm-AgentHost.exe"
if not exist "%AGENT_HOST%" goto FAILED
start "" "%AGENT_HOST%" -Role tray -Resume
exit /b 0
:FAILED
echo Installed PharmFarm windowless launcher was not found. Run the installer first.
pause
exit /b 1
