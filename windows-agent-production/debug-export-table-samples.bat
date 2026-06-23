@echo off
setlocal
pushd "%~dp0"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" goto POWERSHELL_NOT_FOUND

echo PharmFarm table sample export writes local CSV files only.
echo It exports TOP 20 sample rows per table and masks sensitive-looking columns by column name.
echo WARNING: files may still contain sensitive prescription or pharmacy business data.
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0debug-export-table-samples.ps1" -Server ".\EPHARM_DB" -SampleRowsPerTable 20 -MaxCellLength 240
pause
exit /b %ERRORLEVEL%

:POWERSHELL_NOT_FOUND
echo Windows PowerShell was not found.
echo Check: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
pause
exit /b 1
