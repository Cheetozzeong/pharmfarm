# Windows PowerShell 5.1 compatible. Dot-source only; no processes are started here.
function Get-PharmFarmLifecyclePath {
  param([string]$InstallRoot, [string]$Name)
  $directory = Join-Path $InstallRoot "lifecycle"
  [void][IO.Directory]::CreateDirectory($directory)
  return Join-Path $directory $Name
}

function Enter-PharmFarmLock {
  param([string]$InstallRoot, [string]$Name, [int]$WaitSeconds = 0)
  $path = Get-PharmFarmLifecyclePath $InstallRoot ($Name + ".lock")
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  do {
    try {
      # Never delete lock files: another process may still hold the original inode.
      return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { return $null }
      Start-Sleep -Milliseconds 100
    }
  } while ($true)
}

function Exit-PharmFarmLock {
  param($Handle)
  if ($null -ne $Handle) { $Handle.Dispose() }
}

function Enter-PharmFarmGate {
  param([string]$InstallRoot)
  $handle = Enter-PharmFarmLock -InstallRoot $InstallRoot -Name "gate" -WaitSeconds 10
  if ($null -eq $handle) { throw "PharmFarm lifecycle is busy; retry after the current operation finishes." }
  return $handle
}

function Write-PharmFarmControlFile {
  param([string]$Path, $Value)
  $temporaryPath = $Path + "." + [Guid]::NewGuid().ToString("N") + ".tmp"
  try {
    $json = $Value | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($temporaryPath, $json, (New-Object Text.UTF8Encoding($true)))
    if ([IO.File]::Exists($Path)) {
      [IO.File]::Replace($temporaryPath, $Path, [NullString]::Value)
    } else {
      [IO.File]::Move($temporaryPath, $Path)
    }
  } finally {
    if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
  }
}

function Test-PharmFarmPaused {
  param([string]$InstallRoot, [ValidateSet("agent", "tray")][string]$Role)
  # Existence is intentional: even an unreadable/corrupt pause marker fails closed.
  return Test-Path -LiteralPath (Get-PharmFarmLifecyclePath $InstallRoot ($Role + ".paused.json")) -ErrorAction Stop
}

function Set-PharmFarmPaused {
  param([string]$InstallRoot, [ValidateSet("agent", "tray")][string]$Role, [bool]$Paused)
  $gate = Enter-PharmFarmGate $InstallRoot
  try {
    $path = Get-PharmFarmLifecyclePath $InstallRoot ($Role + ".paused.json")
    if ($Paused) {
      Write-PharmFarmControlFile $path @{ reason = "user"; createdAt = [DateTimeOffset]::Now.ToString("o") }
    } elseif (Test-Path -LiteralPath $path -ErrorAction Stop) {
      Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
  } finally { Exit-PharmFarmLock $gate }
}

function Set-PharmFarmDisabled {
  param([string]$InstallRoot, [bool]$Disabled)
  $gate = Enter-PharmFarmGate $InstallRoot
  try {
    $path = Get-PharmFarmLifecyclePath $InstallRoot "disabled.json"
    if ($Disabled) {
      Write-PharmFarmControlFile $path @{ reason = "uninstalled"; createdAt = [DateTimeOffset]::Now.ToString("o") }
    } elseif (Test-Path -LiteralPath $path -ErrorAction Stop) {
      Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
  } finally { Exit-PharmFarmLock $gate }
}

function Test-PharmFarmRuntimeLocked {
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog")][string]$Role)
  $handle = Enter-PharmFarmLock -InstallRoot $InstallRoot -Name $Role
  if ($null -eq $handle) { return $true }
  Exit-PharmFarmLock $handle
  return $false
}

function Test-PharmFarmStartAllowed {
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog")][string]$Role, [string]$MaintenanceToken = "")
  if (Test-Path -LiteralPath (Get-PharmFarmLifecyclePath $InstallRoot "disabled.json") -ErrorAction Stop) { return $false }
  $maintenancePath = Get-PharmFarmLifecyclePath $InstallRoot "maintenance.json"
  if (Test-Path -LiteralPath $maintenancePath -ErrorAction Stop) {
    if ($Role -ne "agent" -or [string]::IsNullOrWhiteSpace($MaintenanceToken)) { return $false }
    try { $maintenance = Get-Content -LiteralPath $maintenancePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { return $false }
    if ($maintenance.token -cne $MaintenanceToken) { return $false }
    $owner = Enter-PharmFarmLock -InstallRoot $InstallRoot -Name "maintenance-owner"
    if ($null -ne $owner) {
      Exit-PharmFarmLock $owner
      return $false # A token from a crashed/finished maintenance operation is invalid.
    }
    return $true
  }
  if (![string]::IsNullOrWhiteSpace($MaintenanceToken)) { return $false }
  if ($Role -ne "watchdog" -and (Test-PharmFarmPaused -InstallRoot $InstallRoot -Role $Role)) { return $false }
  return $true
}

function Enter-PharmFarmRuntime {
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog")][string]$Role, [string]$MaintenanceToken = "")
  $gate = Enter-PharmFarmGate $InstallRoot
  try {
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role $Role -MaintenanceToken $MaintenanceToken)) { return $null }
    $handle = Enter-PharmFarmLock -InstallRoot $InstallRoot -Name $Role
    if ($null -eq $handle) { return $null }
    try {
      # Older installed versions do not hold a lock. Refuse to overlap one during a manual package launch.
      if ($env:OS -eq "Windows_NT") {
        $selfStartedAt = (Get-Process -Id $PID -ErrorAction Stop).StartTime
        foreach ($other in @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @($Role))) {
          $otherProcess = Get-Process -Id $other.ProcessId -ErrorAction SilentlyContinue
          if ($null -eq $otherProcess) { continue }
          # Earliest launcher wins, so two simultaneous new launchers do not reject each other.
          if ($otherProcess.StartTime -lt $selfStartedAt -or ($otherProcess.StartTime -eq $selfStartedAt -and $other.ProcessId -lt $PID)) {
            Exit-PharmFarmLock $handle
            return $null
          }
        }
      }
      return $handle
    } catch {
      Exit-PharmFarmLock $handle
      throw
    }
  } finally { Exit-PharmFarmLock $gate }
}

function Enter-PharmFarmMaintenance {
  param([string]$InstallRoot, [string]$Reason, [switch]$RecoverStale)
  $owner = Enter-PharmFarmLock -InstallRoot $InstallRoot -Name "maintenance-owner"
  if ($null -eq $owner) { throw "Another PharmFarm maintenance operation is already running." }
  $gate = $null
  try {
    $gate = Enter-PharmFarmGate $InstallRoot
    $path = Get-PharmFarmLifecyclePath $InstallRoot "maintenance.json"
    if ((Test-Path -LiteralPath $path -ErrorAction Stop) -and !$RecoverStale) {
      throw "Previous PharmFarm maintenance did not finish. Run repair-pharmfarm-agent.bat before restarting."
    }
    $token = [Guid]::NewGuid().ToString("N")
    Write-PharmFarmControlFile $path @{ token = $token; reason = $Reason; processId = $PID; createdAt = [DateTimeOffset]::Now.ToString("o") }
    return [pscustomobject]@{ Token = $token; Handle = $owner }
  } catch {
    Exit-PharmFarmLock $owner
    throw
  } finally { Exit-PharmFarmLock $gate }
}

function Exit-PharmFarmMaintenance {
  param([string]$InstallRoot, $Lease, [switch]$Success)
  if ($null -eq $Lease) { return }
  $gate = $null
  try {
    $gate = Enter-PharmFarmGate $InstallRoot
    if ($Success) {
      $path = Get-PharmFarmLifecyclePath $InstallRoot "maintenance.json"
      if (Test-Path -LiteralPath $path -ErrorAction Stop) {
        $value = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($value.token -cne $Lease.Token) { throw "Maintenance token mismatch; recovery remains blocked." }
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
      }
    }
    # On failure keep the marker, but release ownership so an explicit repair can recover.
  } finally {
    Exit-PharmFarmLock $gate
    Exit-PharmFarmLock $Lease.Handle
  }
}

function Get-PharmFarmCommandArgument {
  param([string]$CommandLine, [string]$Name)
  $tokens = @([regex]::Matches($CommandLine, '"[^"]*"|\S+') | ForEach-Object { $_.Value.Trim('"') })
  for ($index = 0; $index -lt $tokens.Count - 1; $index++) {
    # Do not mistake PowerShell code or encoded commands for a script invocation.
    if ($tokens[$index] -match '^-(Command|EncodedCommand|c|enc)$') { return "" }
    if ($tokens[$index] -ieq $Name) { return $tokens[$index + 1] }
  }
  return ""
}

function Get-PharmFarmProcesses {
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog")][string[]]$Roles = @("agent", "tray", "watchdog"))
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction Stop)
  } catch {
    $processes = @(Get-WmiObject -Class Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction Stop)
  }
  $names = @{ agent = "PharmFarm-Agent.ps1"; tray = "PharmFarm-AgentTray.ps1"; watchdog = "PharmFarm-AgentWatchdog.ps1" }
  foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID) { continue }
    $commandLine = [string]$process.CommandLine
    $file = Get-PharmFarmCommandArgument $commandLine "-File"
    if ([string]::IsNullOrWhiteSpace($file)) { continue }
    foreach ($role in $Roles) {
      $target = Join-Path $InstallRoot $names[$role]
      $matchesTarget = [string]::Equals($file, $target, [StringComparison]::OrdinalIgnoreCase)
      $ambiguousLegacy = $false
      if (!$matchesTarget -and [string]::Equals([IO.Path]::GetFileName($file), $names[$role], [StringComparison]::OrdinalIgnoreCase)) {
        # A manual package launcher must explicitly target this installation.
        $rootArgument = Get-PharmFarmCommandArgument $commandLine "-InstallRoot"
        $configArgument = Get-PharmFarmCommandArgument $commandLine "-ConfigPath"
        $matchesTarget = [string]::Equals($rootArgument, $InstallRoot, [StringComparison]::OrdinalIgnoreCase) -or
          [string]::Equals($configArgument, (Join-Path $InstallRoot "agent.config.json"), [StringComparison]::OrdinalIgnoreCase)
        if (!$matchesTarget -and [string]::IsNullOrWhiteSpace($rootArgument) -and [string]::IsNullOrWhiteSpace($configArgument) -and
          ![string]::IsNullOrWhiteSpace($env:ProgramData) -and
          [string]::Equals($InstallRoot, (Join-Path $env:ProgramData "PharmFarmAgent"), [StringComparison]::OrdinalIgnoreCase)) {
          # Pre-1.4 console/resync launchers omitted ConfigPath and used the default installation.
          # Block overlaps, but require an operator to close this ambiguous source-path process.
          $matchesTarget = $true
          $ambiguousLegacy = $true
        }
      }
      if ($matchesTarget) {
        $process | Add-Member -NotePropertyName PharmFarmAmbiguousLegacy -NotePropertyValue $ambiguousLegacy -Force
        $process
        break
      }
    }
  }
}

function Stop-PharmFarmProcesses {
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog")][string[]]$Roles = @("watchdog", "agent", "tray"))
  $taskNames = @{ agent = "PharmFarmAgent"; tray = "PharmFarmAgentTray"; watchdog = "PharmFarmAgentWatchdog" }
  foreach ($role in $Roles) {
    try { Stop-ScheduledTask -TaskName $taskNames[$role] -ErrorAction Stop | Out-Null }
    catch {
      $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
      if (Test-Path -LiteralPath $schtasks) {
        # An older installation has no watchdog task. Windows PowerShell 5.1
        # turns schtasks stderr for that absent task into a terminating error
        # under Stop. Task termination is best-effort; the exact process and
        # runtime-lock checks below remain the authoritative stop verification.
        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = "Continue"
          & $schtasks /End /TN $taskNames[$role] 2>&1 | Out-Null
        } finally { $ErrorActionPreference = $previousPreference }
      }
    }
  }
  foreach ($process in @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles $Roles)) {
    if ($process.PharmFarmAmbiguousLegacy) {
      throw "Legacy manual PharmFarm process $($process.ProcessId) has no explicit installation path. Close that launcher after verifying its file path, then retry; it was not force-killed."
    }
    $liveProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $liveProcess) { continue }
    try {
      # Bind the Process object to a native handle before re-checking identity, preventing PID reuse kills.
      [void]$liveProcess.Handle
      $fresh = @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles $Roles | Where-Object { $_.ProcessId -eq $process.ProcessId })
      if ($fresh.Count -eq 0 -or $liveProcess.HasExited) { continue }
      if ($fresh[0].PharmFarmAmbiguousLegacy -or $null -eq $process.CreationDate -or
        [string]$fresh[0].CreationDate -cne [string]$process.CreationDate -or
        [string]$fresh[0].CommandLine -cne [string]$process.CommandLine) {
        throw "PharmFarm process identity changed before stop; retry after inspecting the running process."
      }
      $liveProcess.Kill()
    } catch {
      if (!$liveProcess.HasExited) { throw }
    } finally { $liveProcess.Dispose() }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $remaining = @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles $Roles)
    $locked = @($Roles | Where-Object { Test-PharmFarmRuntimeLocked -InstallRoot $InstallRoot -Role $_ })
    if ($remaining.Count -eq 0 -and $locked.Count -eq 0) { return }
    if ([DateTime]::UtcNow -ge $deadline) { throw "PharmFarm processes did not stop; no runtime/data files may be changed." }
    Start-Sleep -Milliseconds 200
  } while ($true)
}
