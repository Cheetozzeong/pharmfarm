param(
  [string]$InstallRoot = (Join-Path $env:ProgramData "PharmFarmAgent"),
  [string]$SourceRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "PharmFarm-AgentLifecycle.ps1")
. (Join-Path $PSScriptRoot "PharmFarm-AgentTasks.ps1")

try {
  $configPath = Join-Path $InstallRoot "agent.config.json"
  if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Existing agent.config.json was not found. Run install-pharmfarm-agent.bat for a new installation."
  }
  # Validate locally without printing credentials or changing configuration/device identity.
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (!$config.pharmacyId -or [string]::IsNullOrWhiteSpace([string]$config.deviceId)) {
    throw "Existing pharmacyId/deviceId is missing. Repair cannot create or replace the device identity."
  }
  $originalConfigHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
  Write-Host "Checking the existing Windows account and automatic-start protection..."
  $result = Invoke-PharmFarmRuntimeUpdate -SourceRoot $SourceRoot -InstallRoot $InstallRoot -Validate {
    $currentConfigHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
    if ($currentConfigHash -ne $originalConfigHash) { throw "Configuration changed during repair; automatic start was not released." }
  }

  $report = [ordered]@{
    completedAt = [DateTimeOffset]::Now.ToString("o")
    settingsVerified = $true
    configPreserved = $true
    manualPausesPreserved = $true
    backupPath = $result.BackupRoot
    tasks = $result.Tasks
    runtimeStartRequested = $false
    serverConnectionVerified = $false
  }
  $reportPath = Join-Path $InstallRoot "agent.repair-report.json"
  Write-PharmFarmControlFile -Path $reportPath -Value $report
  Start-PharmFarmProtection
  $report.runtimeStartRequested = $true
  Write-PharmFarmControlFile -Path $reportPath -Value $report
  Write-Host "Repair complete: all three scheduled tasks were read back and verified."
  Write-Host "The watchdog now checks every minute after the installation user signs in."
  Write-Host "Configuration, device ID, queues, sync hashes, and manual pauses were preserved."
  Write-Host "No overwrite/resync command was requested. Normal collection resumes unless paused or disabled."
  Write-Host "Backup: $($result.BackupRoot)"
  Write-Host "Report: $reportPath"
  Write-Host "Confirm recent heartbeat and collection status in CMS; this repair does not assert that the server is online."
  exit 0
} catch {
  Write-Host "Repair failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Automatic-start protection or current execution was not fully verified. Keep the error and any backup path for support."
  exit 1
}
