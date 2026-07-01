@echo off
setlocal
pushd "%~dp0"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" goto POWERSHELL_NOT_FOUND

set "PRESCRIPTION_CODE=%~1"
if "%PRESCRIPTION_CODE%"=="" set "PRESCRIPTION_CODE=202607010027"

echo PharmFarm prescription trace export writes local CSV files only.
echo Prescription code: %PRESCRIPTION_CODE%
echo It exports the matching prescription rows, drug rows, master rows, and candidate table hits.
echo WARNING: exported files may contain sensitive prescription or patient-related data.
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0debug-export-prescription-trace.ps1" -Server ".\EPHARM_DB" -PrescriptionCode "%PRESCRIPTION_CODE%" -InsuranceCode "629700750" "657300850"
pause
exit /b %ERRORLEVEL%

:POWERSHELL_NOT_FOUND
echo Windows PowerShell was not found.
echo Check: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
pause
exit /b 1
