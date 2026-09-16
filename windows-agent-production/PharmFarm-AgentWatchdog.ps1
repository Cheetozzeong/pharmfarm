param([string]$InstallRoot = (Join-Path $env:ProgramData "PharmFarmAgent"))

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "PharmFarm-AgentLifecycle.ps1")
$runtime = $null
$results = @()

function Write-WatchdogLog {
  param([string]$Message)
  $logDirectory = Join-Path $InstallRoot "logs"
  [void][IO.Directory]::CreateDirectory($logDirectory)
  $path = Join-Path $logDirectory ("watchdog-{0}.log" -f (Get-Date -Format "yyyyMMdd"))
  Add-Content -LiteralPath $path -Encoding UTF8 -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}

function Test-WatchdogTargetRunning {
  param([string]$Role)
  if (Test-PharmFarmRuntimeLocked -InstallRoot $InstallRoot -Role $Role) { return $true }
  return @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @($Role)).Count -gt 0
}

try {
  # Compatibility for direct script invocations. Native scheduled watchdog owns
  # supervisor recovery in 1.4.2; never compete with its retry budget.
  if (Test-PharmFarmRuntimeLocked -InstallRoot $InstallRoot -Role supervisor) { exit 0 }
  $runtime = Enter-PharmFarmRuntime -InstallRoot $InstallRoot -Role "watchdog"
  if ($null -eq $runtime) { exit 0 }
  if (!(Test-Path -LiteralPath (Join-Path $InstallRoot "agent.config.json"))) { throw "Agent configuration is missing; run the installer." }
  $targets = @(
    @{ role = "agent"; task = "PharmFarmAgent"; file = "PharmFarm-Agent.ps1"; arguments = "-ConfigPath `"$(Join-Path $InstallRoot 'agent.config.json')`"" },
    @{ role = "tray"; task = "PharmFarmAgentTray"; file = "PharmFarm-AgentTray.ps1"; arguments = "-InstallRoot `"$InstallRoot`"" }
  )
  foreach ($target in $targets) {
    $role = $target.role
    # Children re-check the same controls under the lifecycle gate before taking their singleton lock.
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role $role)) {
      $results += @{ role = $role; status = "suppressed" }
      continue
    }
    if (Test-WatchdogTargetRunning $role) {
      $results += @{ role = $role; status = "running" }
      continue
    }
    try {
      try { Start-ScheduledTask -TaskName $target.task -ErrorAction Stop | Out-Null }
      catch { Write-WatchdogLog "$role task start failed: $($_.Exception.Message)" }
      Start-Sleep -Seconds 2
      if (!(Test-WatchdogTargetRunning $role) -and (Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role $role)) {
        $scriptPath = Join-Path $InstallRoot $target.file
        if (!(Test-Path -LiteralPath $scriptPath)) { throw "Missing runtime file: $($target.file)" }
        Start-PharmFarmHiddenRuntime -InstallRoot $InstallRoot -Role $role
        Start-Sleep -Seconds 2
      }
      if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role $role)) {
        $results += @{ role = $role; status = "suppressed" }
      } elseif (Test-WatchdogTargetRunning $role) {
        $results += @{ role = $role; status = "restarted" }
        Write-WatchdogLog "$role process recovered; server/SQL health must be checked separately."
      } else { throw "$role did not start; inspect agent logs, task permissions and runtime files." }
    } catch {
      Write-WatchdogLog "$role recovery failed: $($_.Exception.Message)"
      $results += @{ role = $role; status = "error"; message = $_.Exception.Message }
    }
  }
  $state = @{ checkedAt = [DateTimeOffset]::Now.ToString("o"); processId = $PID; targets = $results }
  Write-PharmFarmControlFile -Path (Join-Path $InstallRoot "watchdog.state.json") -Value $state
  if (@($results | Where-Object { $_.status -eq "error" }).Count -gt 0) { exit 1 }
} catch {
  Write-WatchdogLog "watchdog failed: $($_.Exception.Message)"
  exit 1
} finally { Exit-PharmFarmLock $runtime }
