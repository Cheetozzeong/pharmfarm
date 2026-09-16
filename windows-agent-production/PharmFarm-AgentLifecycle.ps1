# Windows PowerShell 5.1 compatible. Dot-source only; no processes are started here.
function ConvertTo-PharmFarmNativeArgument {
  param([AllowEmptyString()][string]$Value)
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function New-PharmFarmHiddenProcessInfo {
  param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FilePath
  $info.Arguments = (@($Arguments | ForEach-Object { ConvertTo-PharmFarmNativeArgument $_ }) -join ' ')
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  return $info
}

function Start-PharmFarmNativeProcess {
  param([Diagnostics.ProcessStartInfo]$Info)
  return [Diagnostics.Process]::Start($Info)
}

function Invoke-PharmFarmHiddenNative {
  param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 30)
  $info = New-PharmFarmHiddenProcessInfo -FilePath $FilePath -Arguments $Arguments -WorkingDirectory (Split-Path -Parent $FilePath)
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = Start-PharmFarmNativeProcess $info
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill()
      throw "Native support command timed out: $([IO.Path]::GetFileName($FilePath))"
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = ($stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()).Trim() }
  } finally { $process.Dispose() }
}

function Start-PharmFarmHiddenRuntime {
  param([string]$InstallRoot, [ValidateSet('agent', 'tray', 'watchdog', 'supervisor')][string]$Role,
    [switch]$Wait, [switch]$ResyncTodayPrescriptions, [string]$MaintenanceToken = '')
  $hostPath = Join-Path $InstallRoot 'PharmFarm-AgentHost.exe'
  if (!(Test-Path -LiteralPath $hostPath -PathType Leaf)) { throw 'Windowless launcher is missing. Run repair-pharmfarm-agent.bat.' }
  $arguments = @('-Role', $Role)
  if ($ResyncTodayPrescriptions) {
    if ($Role -ne 'agent' -or $MaintenanceToken -notmatch '^[a-fA-F0-9]{32}$') { throw 'Invalid maintenance launch.' }
    $arguments += @('-ResyncTodayPrescriptions', '-MaintenanceToken', $MaintenanceToken)
  } elseif ($MaintenanceToken) { throw 'Maintenance token requires an explicit resync.' }
  $info = New-PharmFarmHiddenProcessInfo -FilePath $hostPath -Arguments $arguments -WorkingDirectory $InstallRoot
  $process = Start-PharmFarmNativeProcess $info
  try {
    if ($Wait) { $process.WaitForExit(); return [pscustomobject]@{ ExitCode = $process.ExitCode } }
  } finally { $process.Dispose() }
}

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
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog", "supervisor")][string]$Role)
  $handle = Enter-PharmFarmLock -InstallRoot $InstallRoot -Name $Role
  if ($null -eq $handle) { return $true }
  Exit-PharmFarmLock $handle
  return $false
}

function Test-PharmFarmStartAllowed {
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog", "supervisor")][string]$Role, [string]$MaintenanceToken = "")
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
  if ($Role -in @("agent", "tray") -and (Test-PharmFarmPaused -InstallRoot $InstallRoot -Role $Role)) { return $false }
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
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog", "supervisor")][string[]]$Roles = @("agent", "tray", "watchdog", "supervisor"), [switch]$IncludeLaunchers)
  $filter = "Name = 'powershell.exe' OR Name = 'pwsh.exe'"
  if ($IncludeLaunchers) { $filter += " OR Name = 'PharmFarm-AgentHost.exe'" }
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)
  } catch {
    $processes = @(Get-WmiObject -Class Win32_Process -Filter $filter -ErrorAction Stop)
  }
  $names = @{ agent = "PharmFarm-Agent.ps1"; tray = "PharmFarm-AgentTray.ps1"; watchdog = "PharmFarm-AgentWatchdog.ps1" }
  foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID) { continue }
    $commandLine = [string]$process.CommandLine
    if ($process.Name -ieq 'PharmFarm-AgentHost.exe') {
      # Hosts are stopped during repair/uninstall, but never count as a live collector:
      # a host may be waiting for its child to acquire the runtime singleton.
      $hostRole = Get-PharmFarmCommandArgument $commandLine '-Role'
      if (!$hostRole -and $commandLine -match '^\s*("[^"]+"|\S+)\s*$') { $hostRole = 'tray' } # Double-click resume.
      if ($IncludeLaunchers -and $hostRole -in $Roles -and
        [string]::Equals([string]$process.ExecutablePath, (Join-Path $InstallRoot 'PharmFarm-AgentHost.exe'), [StringComparison]::OrdinalIgnoreCase)) {
        $process | Add-Member -NotePropertyName PharmFarmAmbiguousLegacy -NotePropertyValue $false -Force
        $process
      }
      continue
    }
    $file = Get-PharmFarmCommandArgument $commandLine "-File"
    if ([string]::IsNullOrWhiteSpace($file)) { continue }
    foreach ($role in $Roles) {
      if ($role -eq 'supervisor') { continue } # Native executable only; no PowerShell script.
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
  param([string]$InstallRoot, [ValidateSet("agent", "tray", "watchdog", "supervisor")][string[]]$Roles = @("watchdog", "supervisor", "agent", "tray"), [switch]$SkipScheduledTasks)
  $taskNames = @{ agent = "PharmFarmAgent"; tray = "PharmFarmAgentTray"; watchdog = "PharmFarmAgentWatchdog" }
  foreach ($role in $Roles) {
    if ($SkipScheduledTasks -or $role -eq 'supervisor') { continue } # Independent Startup entry, or isolated test cleanup.
    try { Stop-ScheduledTask -TaskName $taskNames[$role] -ErrorAction Stop | Out-Null }
    catch {
      $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
      if (Test-Path -LiteralPath $schtasks) {
        # Absent legacy tasks are normal. Capture native stderr/exit status without
        # a console; process/lock verification below remains authoritative.
        Invoke-PharmFarmHiddenNative -FilePath $schtasks -Arguments @('/End', '/TN', $taskNames[$role]) | Out-Null
      }
    }
  }
  foreach ($process in @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles $Roles -IncludeLaunchers)) {
    if ($process.PharmFarmAmbiguousLegacy) {
      throw "Legacy manual PharmFarm process $($process.ProcessId) has no explicit installation path. Close that launcher after verifying its file path, then retry; it was not force-killed."
    }
    $liveProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $liveProcess) { continue }
    try {
      # Bind the Process object to a native handle before re-checking identity, preventing PID reuse kills.
      [void]$liveProcess.Handle
      $fresh = @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles $Roles -IncludeLaunchers | Where-Object { $_.ProcessId -eq $process.ProcessId })
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
    $remaining = @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles $Roles -IncludeLaunchers)
    $locked = @($Roles | Where-Object { Test-PharmFarmRuntimeLocked -InstallRoot $InstallRoot -Role $_ })
    if ($remaining.Count -eq 0 -and $locked.Count -eq 0) { return }
    if ([DateTime]::UtcNow -ge $deadline) { throw "PharmFarm processes did not stop; no runtime/data files may be changed." }
    Start-Sleep -Milliseconds 200
  } while ($true)
}

function Write-PharmFarmProgress {
  param([string]$InstallRoot, [string]$Phase)
  # Record actual collector thread progress, not a timer or API success. No patient data.
  $now = [DateTime]::UtcNow
  if ($null -ne $script:PharmFarmProgressAt -and ($now - $script:PharmFarmProgressAt).TotalSeconds -lt 5) { return }
  try {
    if ($null -eq $script:PharmFarmProcessStartTicks) {
      $script:PharmFarmProcessStartTicks = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks
    }
    $path = Get-PharmFarmLifecyclePath $InstallRoot 'agent.progress'
    $temp = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
      $safePhase = $Phase -replace '[^a-zA-Z0-9-]', ''
      [IO.File]::WriteAllText($temp, "1`n$PID`n$script:PharmFarmProcessStartTicks`n$($now.Ticks)`n$safePhase")
      if ([IO.File]::Exists($path)) { [IO.File]::Replace($temp, $path, [NullString]::Value) }
      else { [IO.File]::Move($temp, $path) }
      $script:PharmFarmProgressAt = $now
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
  } catch {
    # Missing observability must not interrupt collection. Supervisor fails closed on invalid progress.
  }
}
