param([string]$InstallRoot = (Join-Path $env:ProgramData "PharmFarmAgent"))

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "PharmFarm-AgentLifecycle.ps1")
. (Join-Path $PSScriptRoot "PharmFarm-AgentTasks.ps1")

$lease = $null
$success = $false
$failures = New-Object System.Collections.Generic.List[string]
try {
  # A service/access failure must not be mistaken for an absent installation.
  $snapshot = @(Get-PharmFarmTaskSnapshot)
  Assert-PharmFarmTaskIdentity -Snapshot $snapshot -UserSid (Get-PharmFarmCurrentUserSid) -InstallRoot $InstallRoot
  $lease = Enter-PharmFarmMaintenance -InstallRoot $InstallRoot -Reason "uninstall" -RecoverStale
  Assert-PharmFarmTaskIdentity -Snapshot @(Get-PharmFarmTaskSnapshot) -UserSid (Get-PharmFarmCurrentUserSid) -InstallRoot $InstallRoot
  Set-PharmFarmDisabled -InstallRoot $InstallRoot -Disabled $true
  try { Suspend-PharmFarmAutostart }
  catch { $failures.Add($_.Exception.Message) }
  try { Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("watchdog", "supervisor", "agent", "tray") }
  catch { $failures.Add($_.Exception.Message) }
  foreach ($taskName in @("PharmFarmAgentWatchdog", "PharmFarmAgent", "PharmFarmAgentTray")) {
    try { Remove-PharmFarmRegisteredTask -TaskName $taskName }
    catch { $failures.Add($_.Exception.Message) }
  }
  try { Remove-PharmFarmStartupShortcuts }
  catch { $failures.Add($_.Exception.Message) }
  try { Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("watchdog", "supervisor", "agent", "tray") }
  catch { $failures.Add($_.Exception.Message) }
  if ($failures.Count -gt 0) { throw ($failures -join "`r`n") }
  $success = $true
} catch {
  Write-Host "Uninstall incomplete: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Do not assume all processes or tasks have stopped. Resolve the listed failures and rerun uninstall."
} finally {
  if ($null -ne $lease) {
    try { Exit-PharmFarmMaintenance -InstallRoot $InstallRoot -Lease $lease -Success:$success }
    catch { $success = $false; Write-Host "Maintenance cleanup failed: $($_.Exception.Message)" -ForegroundColor Red }
  }
}

if (!$success) { exit 1 }
Write-Host "All three PharmFarm scheduled tasks and Startup shortcuts were removed; runtime processes were checked as stopped."
Write-Host "The disabled marker prevents automatic recovery from recreating the processes."
Write-Host "Runtime files, configuration, queues, hashes, logs, and backups remain at $InstallRoot."
Write-Host "Run install-pharmfarm-agent.bat to explicitly reinstall and enable collection again."
exit 0
