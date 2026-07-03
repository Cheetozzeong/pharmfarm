@echo off
setlocal
set "TASK_NAME=PharmFarmAgent"
set "TRAY_TASK_NAME=PharmFarmAgentTray"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
schtasks /End /TN "%TASK_NAME%" >nul 2>nul
schtasks /End /TN "%TRAY_TASK_NAME%" >nul 2>nul
schtasks /Delete /TN "%TASK_NAME%" /F
schtasks /Delete /TN "%TRAY_TASK_NAME%" /F
if exist "%STARTUP_DIR%\PharmFarmAgent.lnk" del /f /q "%STARTUP_DIR%\PharmFarmAgent.lnk"
if exist "%STARTUP_DIR%\PharmFarmAgentTray.lnk" del /f /q "%STARTUP_DIR%\PharmFarmAgentTray.lnk"

echo.
echo PharmFarm Agent scheduled tasks and startup shortcuts removed.
echo Runtime files remain under ProgramData for audit/queue recovery.
pause
