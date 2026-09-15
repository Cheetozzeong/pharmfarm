# Shared Task Scheduler definitions and update transactions. Dot-source only.

function Get-PharmFarmTaskDefinitions {
  return @(
    [pscustomobject]@{ Role = "agent"; Name = "PharmFarmAgent"; Script = "PharmFarm-Agent.ps1" },
    [pscustomobject]@{ Role = "tray"; Name = "PharmFarmAgentTray"; Script = "PharmFarm-AgentTray.ps1" },
    [pscustomobject]@{ Role = "watchdog"; Name = "PharmFarmAgentWatchdog"; Script = "PharmFarm-AgentWatchdog.ps1" }
  )
}

function Get-PharmFarmPackageFileNames {
  return @(
    "PharmFarm-Agent.ps1", "PharmFarm-AgentTray.ps1", "PharmFarm-AgentLifecycle.ps1", "PharmFarm-AgentHost.exe",
    "PharmFarm-AgentWatchdog.ps1", "PharmFarm-AgentTasks.ps1", "PharmFarm-AgentRepair.ps1",
    "PharmFarm-AgentUninstall.ps1", "repair-pharmfarm-agent.bat", "uninstall-pharmfarm-agent.bat",
    "run-agent-console.bat", "run-agent-tray.bat",
    "resync-today-prescriptions.bat", "PharmFarm-Agent.ico", "controlled-drug-reference.csv"
  )
}

function Get-PharmFarmCurrentUserSid {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  try { return $identity.User.Value } finally { $identity.Dispose() }
}

function Resolve-PharmFarmUserSid {
  param([string]$UserId)
  if ([string]::IsNullOrWhiteSpace($UserId)) { throw "The scheduled task has no individual Windows user." }
  if ($UserId -match '^S-1-') { return $UserId }
  $account = New-Object System.Security.Principal.NTAccount($UserId)
  return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Get-PharmFarmPowerShellPath {
  # The saved action must use System32, not the transient 32-bit Sysnative alias.
  return Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
}

function Get-PharmFarmSchtasksPath {
  $sysnative = Join-Path $env:SystemRoot "Sysnative\schtasks.exe"
  if (Test-Path -LiteralPath $sysnative) { return $sysnative }
  return Join-Path $env:SystemRoot "System32\schtasks.exe"
}

function Invoke-PharmFarmSchtasks {
  param([string[]]$Arguments)
  $executable = Get-PharmFarmSchtasksPath
  if (!(Test-Path -LiteralPath $executable)) { throw "schtasks.exe was not found." }
  return Invoke-PharmFarmHiddenNative -FilePath $executable -Arguments $Arguments
}

function Get-PharmFarmTaskFolder {
  $scheduler = New-Object -ComObject "Schedule.Service"
  $scheduler.Connect()
  return $scheduler.GetFolder("\")
}

function Get-PharmFarmTaskSnapshot {
  # Enumerating the root distinguishes an absent task from a service/access failure.
  $folder = Get-PharmFarmTaskFolder
  $registered = $folder.GetTasks(1)
  $result = @()
  foreach ($definition in @(Get-PharmFarmTaskDefinitions)) {
    $existing = $null
    foreach ($task in $registered) {
      if ($task.Name -eq $definition.Name) { $existing = $task; break }
    }
    $result += [pscustomobject]@{
      Name = $definition.Name
      Role = $definition.Role
      Exists = $null -ne $existing
      Xml = if ($null -ne $existing) { [string]$existing.Xml } else { $null }
      State = if ($null -ne $existing) { [int]$existing.State } else { 0 }
    }
  }
  return $result
}

function Assert-PharmFarmTaskIdentity {
  param([object[]]$Snapshot, [string]$UserSid, [string]$InstallRoot = "")
  foreach ($task in $Snapshot) {
    if (!$task.Exists) { continue }
    [xml]$document = $task.Xml
    $principal = $document.Task.Principals.Principal
    $existingSid = Resolve-PharmFarmUserSid ([string]$principal.UserId)
    if ($existingSid -ne $UserSid) {
      throw "$($task.Name) belongs to a different Windows user. Sign in as the original installation user before repairing. No account migration was performed."
    }
    if ([string]$principal.LogonType -ne "InteractiveToken") {
      throw "$($task.Name) does not use InteractiveToken. Its credentials cannot be safely backed up or converted by this repair."
    }
    if (![string]::IsNullOrWhiteSpace($InstallRoot)) {
      $definition = @(Get-PharmFarmTaskDefinitions | Where-Object { $_.Name -eq $task.Name })
      $actions = @($document.Task.Actions.Exec)
      if ($definition.Count -ne 1 -or $actions.Count -ne 1 -or @($document.Task.Actions.ChildNodes).Count -ne 1) {
        throw "$($task.Name) has an unsupported action; no task or runtime changes were made."
      }
      $command = [Environment]::ExpandEnvironmentVariables([string]$actions[0].Command)
      if ([string]::Equals($command, (Join-Path $InstallRoot 'PharmFarm-AgentHost.exe'), [StringComparison]::OrdinalIgnoreCase)) {
        if ([string]$actions[0].Arguments -cne ('-Role ' + $definition[0].Role)) {
          throw "$($task.Name) has unexpected launcher arguments. No task or runtime changes were made."
        }
        continue
      }
      if ([IO.Path]::GetFileName($command) -notmatch '^(powershell|pwsh)(\.exe)?$') {
        throw "$($task.Name) does not execute PowerShell; no task or runtime changes were made."
      }
      $arguments = [string]$actions[0].Arguments
      $scriptPath = Get-PharmFarmCommandArgument -CommandLine $arguments -Name "-File"
      $expectedPath = Join-Path $InstallRoot $definition[0].Script
      if ([string]::IsNullOrWhiteSpace($scriptPath) -or [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($scriptPath)) -ne [IO.Path]::GetFullPath($expectedPath)) {
        throw "$($task.Name) points to a different installation or command. No task or runtime changes were made."
      }
      foreach ($argumentName in @("-ConfigPath", "-InstallRoot")) {
        $value = Get-PharmFarmCommandArgument -CommandLine $arguments -Name $argumentName
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $expected = if ($argumentName -eq "-ConfigPath") { Join-Path $InstallRoot "agent.config.json" } else { $InstallRoot }
        if ([IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($value)).TrimEnd('\', '/') -ne [IO.Path]::GetFullPath($expected).TrimEnd('\', '/')) {
          throw "$($task.Name) uses a different $argumentName installation path. No task or runtime changes were made."
        }
      }
    }
  }
}

function New-PharmFarmTaskXml {
  param(
    [ValidateSet("agent", "tray", "watchdog")][string]$Role,
    [string]$InstallRoot,
    [string]$UserSid,
    [DateTime]$StartAt = (Get-Date).AddMinutes(1)
  )
  $definition = @(Get-PharmFarmTaskDefinitions | Where-Object { $_.Role -eq $Role })[0]
  $arguments = '-Role ' + $Role
  $safeSid = [System.Security.SecurityElement]::Escape($UserSid)
  $safeCommand = [System.Security.SecurityElement]::Escape((Join-Path $InstallRoot 'PharmFarm-AgentHost.exe'))
  $safeArguments = [System.Security.SecurityElement]::Escape($arguments)
  $safeDirectory = [System.Security.SecurityElement]::Escape($InstallRoot)
  $executionLimit = if ($Role -eq "watchdog") { "PT2M" } else { "PT0S" }
  $timeTrigger = ""
  if ($Role -eq "watchdog") {
    $boundary = $StartAt.ToString("yyyy-MM-ddTHH:mm:ss")
    # No Duration/EndBoundary: repeat indefinitely, including after a missed login.
    $timeTrigger = @"
    <TimeTrigger id="PeriodicRecovery">
      <StartBoundary>$boundary</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <ExecutionTimeLimit>$executionLimit</ExecutionTimeLimit>
    </TimeTrigger>
"@
  }
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>PharmFarm $Role with independent recovery protection</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger id="UserLogon">
      <Enabled>true</Enabled>
      <ExecutionTimeLimit>$executionLimit</ExecutionTimeLimit>
      <UserId>$safeSid</UserId>
      <Delay>PT10S</Delay>
    </LogonTrigger>
$timeTrigger
  </Triggers>
  <Principals><Principal id="User"><UserId>$safeSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled><Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>$executionLimit</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="User"><Exec><Command>$safeCommand</Command><Arguments>$safeArguments</Arguments><WorkingDirectory>$safeDirectory</WorkingDirectory></Exec></Actions>
</Task>
"@
}

function Register-PharmFarmTaskXml {
  param([string]$TaskName, [string]$Xml)
  $primaryError = ""
  try {
    Register-ScheduledTask -TaskName $TaskName -TaskPath "\" -Xml $Xml -Force -ErrorAction Stop | Out-Null
    return "PowerShell XML"
  } catch { $primaryError = $_.Exception.Message }

  $xmlFile = Join-Path ([System.IO.Path]::GetTempPath()) ("pharmfarm-task-" + [Guid]::NewGuid().ToString("N") + ".xml")
  try {
    Set-Content -LiteralPath $xmlFile -Value $Xml -Encoding Unicode -ErrorAction Stop
    $result = Invoke-PharmFarmSchtasks -Arguments @("/Create", "/TN", $TaskName, "/XML", $xmlFile, "/F")
    if ($result.ExitCode -ne 0) {
      throw "PowerShell: $primaryError; schtasks XML: $($result.Output)"
    }
    return "schtasks XML"
  } finally {
    if (Test-Path -LiteralPath $xmlFile) { Remove-Item -LiteralPath $xmlFile -Force -ErrorAction SilentlyContinue }
  }
}

function Assert-PharmFarmTaskXml {
  param([string]$TaskName, [string]$ActualXml, [string]$ExpectedXml)
  [xml]$actual = $ActualXml
  [xml]$expected = $ExpectedXml
  $checks = @(
    "Principals/Principal/UserId", "Principals/Principal/LogonType", "Principals/Principal/RunLevel",
    "Settings/MultipleInstancesPolicy", "Settings/DisallowStartIfOnBatteries", "Settings/StopIfGoingOnBatteries",
    "Settings/StartWhenAvailable", "Settings/ExecutionTimeLimit", "Settings/Enabled", "Settings/AllowStartOnDemand",
    "Settings/RunOnlyIfIdle", "Settings/RunOnlyIfNetworkAvailable", "Settings/RestartOnFailure/Interval",
    "Settings/RestartOnFailure/Count", "Actions/Exec/Command", "Actions/Exec/Arguments", "Actions/Exec/WorkingDirectory",
    "Triggers/LogonTrigger/UserId", "Triggers/LogonTrigger/Enabled", "Triggers/LogonTrigger/ExecutionTimeLimit", "Triggers/LogonTrigger/Delay"
  )
  if ($TaskName -eq "PharmFarmAgentWatchdog") {
    $checks += @("Triggers/TimeTrigger/Enabled", "Triggers/TimeTrigger/Repetition/Interval", "Triggers/TimeTrigger/Repetition/StopAtDurationEnd", "Triggers/TimeTrigger/ExecutionTimeLimit")
    if ($actual.Task.Triggers.TimeTrigger.Repetition.Duration -or $actual.Task.Triggers.TimeTrigger.EndBoundary) {
      throw "$TaskName has an unexpected repetition expiry."
    }
    $checks += "Triggers/TimeTrigger/StartBoundary"
  }
  $actualNs = New-Object System.Xml.XmlNamespaceManager($actual.NameTable)
  $actualNs.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task")
  $expectedNs = New-Object System.Xml.XmlNamespaceManager($expected.NameTable)
  $expectedNs.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task")
  $defaults = @{
    "Principals/Principal/RunLevel" = "LeastPrivilege"
    "Settings/MultipleInstancesPolicy" = "IgnoreNew"
    "Settings/Enabled" = "true"
    "Settings/AllowStartOnDemand" = "true"
    "Settings/RunOnlyIfIdle" = "false"
    "Settings/RunOnlyIfNetworkAvailable" = "false"
    "Triggers/LogonTrigger/Enabled" = "true"
    "Triggers/TimeTrigger/Enabled" = "true"
    "Triggers/TimeTrigger/Repetition/StopAtDurationEnd" = "false"
  }
  foreach ($path in $checks) {
    $xpath = "/t:Task/t:" + $path.Replace("/", "/t:")
    $actualNode = $actual.SelectSingleNode($xpath, $actualNs)
    $expectedNode = $expected.SelectSingleNode($xpath, $expectedNs)
    $actualValue = if ($null -ne $actualNode) { $actualNode.InnerText } elseif ($defaults.ContainsKey($path)) { $defaults[$path] } else { $null }
    $expectedValue = if ($null -ne $expectedNode) { $expectedNode.InnerText } else { $null }
    if ($path.EndsWith("/UserId") -and $null -ne $actualValue) {
      $actualValue = Resolve-PharmFarmUserSid $actualValue
      $expectedValue = Resolve-PharmFarmUserSid $expectedValue
    } elseif (($path.EndsWith("/ExecutionTimeLimit") -or $path.EndsWith("/Interval") -or $path.EndsWith("/Delay")) -and $null -ne $actualValue) {
      $actualValue = [System.Xml.XmlConvert]::ToTimeSpan($actualValue).Ticks
      $expectedValue = [System.Xml.XmlConvert]::ToTimeSpan($expectedValue).Ticks
    } elseif ($path.EndsWith("/StartBoundary") -and $null -ne $actualValue) {
      $actualValue = [DateTimeOffset]::Parse($actualValue).UtcDateTime.Ticks
      $expectedValue = [DateTimeOffset]::Parse($expectedValue).UtcDateTime.Ticks
    } elseif ($expectedValue -in @("true", "false") -and $null -ne $actualValue) {
      $actualValue = [System.Xml.XmlConvert]::ToBoolean($actualValue).ToString()
      $expectedValue = [System.Xml.XmlConvert]::ToBoolean($expectedValue).ToString()
    }
    if ($null -eq $actualValue -or $null -eq $expectedValue -or $actualValue -ne $expectedValue) {
      throw "$TaskName verification failed: $path. Automatic recovery protection was not verified."
    }
  }
  if (@($actual.Task.Actions.ChildNodes).Count -ne 1 -or @($actual.Task.Principals.Principal).Count -ne 1) {
    throw "$TaskName has unexpected extra actions or principals."
  }
  $expectedTriggerCount = if ($TaskName -eq "PharmFarmAgentWatchdog") { 2 } else { 1 }
  if (@($actual.Task.Triggers.ChildNodes).Count -ne $expectedTriggerCount -or $actual.Task.Triggers.LogonTrigger.EndBoundary) {
    throw "$TaskName has unexpected triggers or a logon expiry."
  }
}

function Register-PharmFarmProtectedTasks {
  param([string]$InstallRoot, [string]$UserSid)
  $results = @()
  foreach ($definition in @(Get-PharmFarmTaskDefinitions)) {
    $xml = New-PharmFarmTaskXml -Role $definition.Role -InstallRoot $InstallRoot -UserSid $UserSid
    $mode = Register-PharmFarmTaskXml -TaskName $definition.Name -Xml $xml
    $registered = @(Get-PharmFarmTaskSnapshot | Where-Object { $_.Name -eq $definition.Name })[0]
    if (!$registered.Exists) { throw "$($definition.Name) disappeared after registration." }
    Assert-PharmFarmTaskXml -TaskName $definition.Name -ActualXml $registered.Xml -ExpectedXml $xml
    $results += [pscustomobject]@{ Name = $definition.Name; Registration = $mode; Verified = $true }
  }
  return $results
}

function Remove-PharmFarmRegisteredTask {
  param([string]$TaskName)
  $existing = @(Get-PharmFarmTaskSnapshot | Where-Object { $_.Name -eq $TaskName })
  if ($existing.Count -eq 0 -or !$existing[0].Exists) { return }
  try {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath "\" -Confirm:$false -ErrorAction Stop
  } catch {
    $result = Invoke-PharmFarmSchtasks -Arguments @("/Delete", "/TN", $TaskName, "/F")
    if ($result.ExitCode -ne 0) { throw "$TaskName removal failed: $($result.Output)" }
  }
  $remaining = @(Get-PharmFarmTaskSnapshot | Where-Object { $_.Name -eq $TaskName -and $_.Exists })
  if ($remaining.Count -gt 0) { throw "$TaskName still exists after removal." }
}

function Get-PharmFarmStartupShortcutPaths {
  $startup = [Environment]::GetFolderPath("Startup")
  if ([string]::IsNullOrWhiteSpace($startup)) { throw "The current user's Startup folder could not be found." }
  foreach ($name in @("PharmFarmAgent.lnk", "PharmFarmAgentTray.lnk", "PharmFarmAgentWatchdog.lnk")) {
    Join-Path $startup $name
  }
}

function Remove-PharmFarmStartupShortcuts {
  foreach ($path in @(Get-PharmFarmStartupShortcutPaths)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction Stop }
  }
}

function Assert-PharmFarmPackage {
  param([string]$SourceRoot, [string]$InstallRoot)
  if ([IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/') -eq [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')) {
    throw "Extract the update package outside the installed ProgramData directory before running setup or repair."
  }
  foreach ($name in @(Get-PharmFarmPackageFileNames)) {
    if (!(Test-Path -LiteralPath (Join-Path $SourceRoot $name) -PathType Leaf)) { throw "The update package is incomplete: $name" }
  }
  Assert-PharmFarmWindowlessHost -SourceRoot $SourceRoot
}

function Assert-PharmFarmWindowlessHost {
  param([string]$SourceRoot)
  # Before disabling old tasks or touching data, exercise the actual Windows GUI
  # executable, hidden child creation, Job assignment, wait and exit-code path.
  $result = Invoke-PharmFarmHiddenNative -FilePath (Join-Path $SourceRoot 'PharmFarm-AgentHost.exe') -Arguments @('-SelfTest')
  if ($result.ExitCode -ne 0) { throw 'Windowless launcher self-test failed. Old installation was not changed; inspect package logs.' }
}

function New-PharmFarmInstallBackup {
  param([string]$InstallRoot, [object[]]$TaskSnapshot, [switch]$IncludeConfig)
  $backupRoot = Join-Path $InstallRoot ("backups\" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N"))
  $filesRoot = Join-Path $backupRoot "files"
  $tasksRoot = Join-Path $backupRoot "tasks"
  $startupRoot = Join-Path $backupRoot "startup"
  foreach ($directory in @($filesRoot, $tasksRoot, $startupRoot)) {
    New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
  }
  $files = @()
  $names = @(Get-PharmFarmPackageFileNames)
  if ($IncludeConfig) { $names += @("agent.config.json", "lifecycle\agent.paused.json", "lifecycle\tray.paused.json", "lifecycle\disabled.json") }
  foreach ($name in $names) {
    $source = Join-Path $InstallRoot $name
    $existed = Test-Path -LiteralPath $source -PathType Leaf
    if ($existed) {
      $destination = Join-Path $filesRoot $name
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force -ErrorAction Stop | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
    }
    $files += [pscustomobject]@{ Name = $name; Existed = $existed }
  }
  foreach ($task in $TaskSnapshot) {
    if ($task.Exists) {
      Set-Content -LiteralPath (Join-Path $tasksRoot ($task.Name + ".xml")) -Value $task.Xml -Encoding Unicode -ErrorAction Stop
    }
  }
  $shortcuts = @()
  foreach ($path in @(Get-PharmFarmStartupShortcutPaths)) {
    $existed = Test-Path -LiteralPath $path -PathType Leaf
    if ($existed) { Copy-Item -LiteralPath $path -Destination (Join-Path $startupRoot ([IO.Path]::GetFileName($path))) -ErrorAction Stop }
    $shortcuts += [pscustomobject]@{ Path = $path; Existed = $existed }
  }
  $backup = [pscustomobject]@{ Root = $backupRoot; Files = $files; Tasks = $TaskSnapshot; Shortcuts = $shortcuts; CreatedAt = [DateTimeOffset]::Now.ToString("o") }
  $backup | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backupRoot "manifest.json") -Encoding UTF8 -ErrorAction Stop
  return $backup
}

function Copy-PharmFarmRuntimePackage {
  param([string]$SourceRoot, [string]$InstallRoot)
  foreach ($name in @(Get-PharmFarmPackageFileNames)) {
    Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination (Join-Path $InstallRoot $name) -Force -ErrorAction Stop
  }
}

function Disable-PharmFarmTaskXml {
  param([string]$Xml)
  [xml]$document = $Xml
  $namespace = "http://schemas.microsoft.com/windows/2004/02/mit/task"
  $settings = $document.Task.Settings
  if ($null -eq $settings) {
    $settings = $document.CreateElement("Settings", $namespace)
    [void]$document.Task.AppendChild($settings)
  }
  $enabled = $settings["Enabled"]
  if ($null -eq $enabled) {
    $enabled = $document.CreateElement("Enabled", $namespace)
    [void]$settings.AppendChild($enabled)
  }
  $enabled.InnerText = "false"
  return $document.OuterXml
}

function Suspend-PharmFarmAutostart {
  $failures = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($task in @(Get-PharmFarmTaskSnapshot)) {
      if (!$task.Exists) { continue }
      try {
        [void](Register-PharmFarmTaskXml -TaskName $task.Name -Xml (Disable-PharmFarmTaskXml $task.Xml))
        $readBack = @(Get-PharmFarmTaskSnapshot | Where-Object { $_.Name -eq $task.Name })[0]
        [xml]$actual = $readBack.Xml
        if (!$readBack.Exists -or [string]$actual.Task.Settings.Enabled -ne "false") { throw "Task did not remain disabled." }
      } catch { $failures.Add("Disable $($task.Name): $($_.Exception.Message)") }
    }
  } catch { $failures.Add("Read task settings: $($_.Exception.Message)") }
  try { Remove-PharmFarmStartupShortcuts }
  catch { $failures.Add("Remove old Startup shortcuts: $($_.Exception.Message)") }
  if ($failures.Count -gt 0) { throw "Could not suspend all automatic starts: $($failures -join '; ')" }
}

function Restore-PharmFarmInstallBackup {
  param([string]$InstallRoot, [object]$Backup, [switch]$RestoreConfig, [switch]$RestoreControls)
  $failures = New-Object System.Collections.Generic.List[string]
  # Restore old binaries before their original task definitions can become eligible.
  foreach ($file in $Backup.Files) {
    # Repair never writes config or user controls. Do not overwrite an external change.
    if ($file.Name -eq "agent.config.json" -and !$RestoreConfig) { continue }
    if ($file.Name.StartsWith("lifecycle\") -and !$RestoreControls) { continue }
    try {
      $target = Join-Path $InstallRoot $file.Name
      if ($file.Existed) {
        Copy-Item -LiteralPath (Join-Path (Join-Path $Backup.Root "files") $file.Name) -Destination $target -Force -ErrorAction Stop
      } elseif (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Force -ErrorAction Stop
      }
    } catch { $failures.Add("File $($file.Name): $($_.Exception.Message)") }
  }
  foreach ($task in $Backup.Tasks) {
    try {
      if ($task.Exists) {
        # Old runtimes do not know the maintenance marker. Keep their original XML
        # in the backup, but disable restored tasks until an explicit repair succeeds.
        [void](Register-PharmFarmTaskXml -TaskName $task.Name -Xml (Disable-PharmFarmTaskXml $task.Xml))
      } else {
        Remove-PharmFarmRegisteredTask -TaskName $task.Name
      }
    } catch { $failures.Add("Task $($task.Name): $($_.Exception.Message)") }
  }
  # Legacy Startup launches ignore lifecycle markers too. Their backups remain available.
  try { Remove-PharmFarmStartupShortcuts }
  catch { $failures.Add("Startup shortcut: $($_.Exception.Message)") }
  if ($failures.Count -gt 0) { throw "Rollback incomplete. Backup: $($Backup.Root). $($failures -join '; ')" }
}

function Start-PharmFarmProtection {
  # The watchdog observes persistent manual pauses and starts only eligible roles.
  try {
    Start-ScheduledTask -TaskName "PharmFarmAgentWatchdog" -TaskPath "\" -ErrorAction Stop
  } catch {
    $result = Invoke-PharmFarmSchtasks -Arguments @("/Run", "/TN", "PharmFarmAgentWatchdog")
    if ($result.ExitCode -ne 0) { throw "Recovery task start failed: $($result.Output)" }
  }
}

function Invoke-PharmFarmRuntimeUpdate {
  param([string]$SourceRoot, [string]$InstallRoot, [scriptblock]$Configure, [scriptblock]$Validate, [switch]$ResetControls)
  Assert-PharmFarmPackage -SourceRoot $SourceRoot -InstallRoot $InstallRoot
  $userSid = Get-PharmFarmCurrentUserSid
  $snapshot = @(Get-PharmFarmTaskSnapshot)
  Assert-PharmFarmTaskIdentity -Snapshot $snapshot -UserSid $userSid -InstallRoot $InstallRoot
  $lease = $null
  $backup = $null
  $success = $false
  try {
    $lease = Enter-PharmFarmMaintenance -InstallRoot $InstallRoot -Reason "install-or-repair" -RecoverStale
    $snapshot = @(Get-PharmFarmTaskSnapshot)
    Assert-PharmFarmTaskIdentity -Snapshot $snapshot -UserSid $userSid -InstallRoot $InstallRoot
    $backup = New-PharmFarmInstallBackup -InstallRoot $InstallRoot -TaskSnapshot $snapshot -IncludeConfig
    # Old versions ignore maintenance markers. Disable their entry points before
    # stopping them so a simultaneous logon cannot launch a partially copied file.
    Suspend-PharmFarmAutostart
    Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("watchdog", "agent", "tray")
    Copy-PharmFarmRuntimePackage -SourceRoot $SourceRoot -InstallRoot $InstallRoot
    if ($null -ne $Configure) { & $Configure }
    $registered = @(Register-PharmFarmProtectedTasks -InstallRoot $InstallRoot -UserSid $userSid)
    Remove-PharmFarmStartupShortcuts
    if ($ResetControls) {
      Set-PharmFarmPaused -InstallRoot $InstallRoot -Role "agent" -Paused $false
      Set-PharmFarmPaused -InstallRoot $InstallRoot -Role "tray" -Paused $false
      Set-PharmFarmDisabled -InstallRoot $InstallRoot -Disabled $false
    }
    if ($null -ne $Validate) { & $Validate }
    $success = $true
    return [pscustomobject]@{ BackupRoot = $backup.Root; Tasks = $registered; UserSid = $userSid }
  } catch {
    $failure = $_.Exception.Message
    if ($null -ne $backup) {
      $stopped = $false
      try {
        Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("watchdog", "agent", "tray")
        $stopped = $true
      } catch { $failure += " Stop verification failed; runtime files were not restored and processes may still be running. $($_.Exception.Message)" }
      if ($stopped) {
        try {
          Restore-PharmFarmInstallBackup -InstallRoot $InstallRoot -Backup $backup -RestoreConfig:($null -ne $Configure) -RestoreControls:$ResetControls
          $failure += " Previous runtime files were restored; restored tasks were disabled. Original task XML and Startup shortcuts remain in backup: $($backup.Root)."
        } catch { $failure += " $($_.Exception.Message)" }
      }
      try {
        Suspend-PharmFarmAutostart
        $failure += " Automatic starts are suspended until repair succeeds."
      } catch { $failure += " $($_.Exception.Message) Automatic starts could not all be disabled; do not assume the agent is stopped." }
    }
    throw "$failure Resolve the error and run repair again."
  } finally {
    if ($null -ne $lease) { Exit-PharmFarmMaintenance -InstallRoot $InstallRoot -Lease $lease -Success:$success }
  }
}
