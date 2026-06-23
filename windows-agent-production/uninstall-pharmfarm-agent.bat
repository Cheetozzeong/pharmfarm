@echo off
setlocal
set "TASK_NAME=PharmFarmAgent"
set "TRAY_TASK_NAME=PharmFarmAgentTray"
schtasks /End /TN "%TASK_NAME%" >nul 2>nul
schtasks /End /TN "%TRAY_TASK_NAME%" >nul 2>nul
schtasks /Delete /TN "%TASK_NAME%" /F
schtasks /Delete /TN "%TRAY_TASK_NAME%" /F

echo.
echo PharmFarm Agent scheduled tasks removed.
echo Runtime files remain under ProgramData for audit/queue recovery.
pause
