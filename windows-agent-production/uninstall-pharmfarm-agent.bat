@echo off
setlocal
set "TASK_NAME=PharmFarmAgent"
schtasks /End /TN "%TASK_NAME%" >nul 2>nul
schtasks /Delete /TN "%TASK_NAME%" /F
echo.
echo PharmFarm Agent scheduled task removed.
echo Runtime files remain under ProgramData for audit/queue recovery.
pause
