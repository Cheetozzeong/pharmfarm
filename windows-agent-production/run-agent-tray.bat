@echo off
setlocal
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" goto FAILED
set "TRAY_PS=%ProgramData%\PharmFarmAgent\PharmFarm-AgentTray.ps1"
if not exist "%TRAY_PS%" goto FAILED
start "" "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%TRAY_PS%" -Resume
exit /b 0
:FAILED
echo Installed PharmFarm tray or Windows PowerShell was not found. Run the installer first.
pause
exit /b 1
