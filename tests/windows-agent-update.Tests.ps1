param([string]$PackageRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "windows-agent-production"))

$ErrorActionPreference = "Stop"
. (Join-Path $PackageRoot "PharmFarm-AgentLifecycle.ps1")
. (Join-Path $PackageRoot "PharmFarm-AgentTasks.ps1")
$script:Assertions = 0
$script:TestRoot = Join-Path ([IO.Path]::GetTempPath()) ("pharmfarm-update-test-" + [Guid]::NewGuid().ToString("N"))
[void][IO.Directory]::CreateDirectory($script:TestRoot)

function Assert-Update {
  param([bool]$Condition, [string]$Message)
  $script:Assertions++
  if (!$Condition) { throw "Assertion failed: $Message" }
}

# Only OS/task primitives are mocked. Package copying, backups, control markers,
# transaction sequencing, XML verification, and rollback run the real functions.
function Get-PharmFarmCurrentUserSid { return "S-1-5-21-111-222-333-1001" }
function Assert-PharmFarmWindowlessHost { param($SourceRoot) }
function Get-PharmFarmPowerShellPath { return Join-Path $script:FixtureRoot "powershell.exe" }
function Get-PharmFarmTaskSnapshot {
  $script:SnapshotCount++
  $result = @()
  foreach ($definition in @(Get-PharmFarmTaskDefinitions)) {
    $task = $script:MockTasks[$definition.Name]
    $result += [pscustomobject]@{
      Name = $definition.Name; Role = $definition.Role; Exists = $null -ne $task
      Xml = if ($null -ne $task) { $task.Xml } else { $null }; State = 3
    }
  }
  return $result
}
function Register-PharmFarmTaskXml {
  param([string]$TaskName, [string]$Xml)
  $script:RegistrationCount++
  if ($script:FailRegistrationAt -eq $script:RegistrationCount) { throw "Injected registration failure." }
  $script:MockTasks[$TaskName] = [pscustomobject]@{ Xml = $Xml }
  return "test XML"
}
function Unregister-ScheduledTask {
  param([string]$TaskName, [string]$TaskPath, [switch]$Confirm)
  $script:MockTasks.Remove($TaskName)
}
function Get-PharmFarmStartupShortcutPaths {
  foreach ($name in @("PharmFarmAgent.lnk", "PharmFarmAgentTray.lnk", "PharmFarmAgentWatchdog.lnk", "PharmFarmAgentSupervisor.lnk")) {
    Join-Path $script:StartupRoot $name
  }
}
function Register-PharmFarmSupervisorStartup {
  param([string]$InstallRoot)
  [IO.File]::WriteAllText((Join-Path $script:StartupRoot 'PharmFarmAgentSupervisor.lnk'), $InstallRoot + '|-Role supervisor')
}
function Stop-PharmFarmProcesses {
  param([string]$InstallRoot, [string[]]$Roles)
  Assert-Update (Test-Path -LiteralPath (Join-Path $InstallRoot "lifecycle/maintenance.json")) "Stop must run under maintenance."
  Assert-Update ($Roles[0] -eq "watchdog") "Watchdog is stopped first."
  $owner = Enter-PharmFarmLock -InstallRoot $InstallRoot -Name "maintenance-owner"
  Assert-Update ($null -eq $owner) "Maintenance ownership must remain exclusive during stop."
  if ($null -ne $owner) { Exit-PharmFarmLock $owner }
  if ($script:FailStop) { throw "Injected process stop failure." }
}

function New-UpdateFixture {
  param([string]$Name)
  $script:FixtureRoot = Join-Path $script:TestRoot $Name
  $script:SourceRoot = Join-Path $script:FixtureRoot "package"
  $script:InstallRoot = Join-Path $script:FixtureRoot "installed"
  $script:StartupRoot = Join-Path $script:FixtureRoot "startup"
  foreach ($directory in @($script:SourceRoot, $script:InstallRoot, $script:StartupRoot)) { [void][IO.Directory]::CreateDirectory($directory) }
  foreach ($name in @(Get-PharmFarmPackageFileNames)) {
    [IO.File]::WriteAllText((Join-Path $script:SourceRoot $name), "updated:$name")
  }
  foreach ($name in @("PharmFarm-Agent.ps1", "PharmFarm-AgentTray.ps1")) {
    [IO.File]::WriteAllText((Join-Path $script:InstallRoot $name), "original:$name")
  }
  [IO.File]::WriteAllText((Join-Path $script:InstallRoot "agent.config.json"), '{"deviceId":"keep-device","pharmacyId":123,"agentSecret":"test-secret"}')
  foreach ($directory in @("queue", "sync-state")) {
    $path = Join-Path $script:InstallRoot $directory
    [void][IO.Directory]::CreateDirectory($path)
    [IO.File]::WriteAllText((Join-Path $path "fixture.json"), "unchanged:$directory")
  }
  Set-PharmFarmPaused -InstallRoot $script:InstallRoot -Role agent -Paused $true
  Set-PharmFarmPaused -InstallRoot $script:InstallRoot -Role tray -Paused $true
  Set-PharmFarmDisabled -InstallRoot $script:InstallRoot -Disabled $true
  $script:OriginalControls = @{}
  foreach ($file in @("agent.paused.json", "tray.paused.json", "disabled.json")) {
    $script:OriginalControls[$file] = [IO.File]::ReadAllText((Join-Path (Join-Path $script:InstallRoot "lifecycle") $file))
  }
  [IO.File]::WriteAllText((Join-Path $script:StartupRoot "PharmFarmAgent.lnk"), "original-shortcut")
  $script:MockTasks = @{}
  foreach ($role in @("agent", "tray")) {
    $definition = @(Get-PharmFarmTaskDefinitions | Where-Object Role -eq $role)[0]
    $xml = New-PharmFarmTaskXml -Role $role -InstallRoot $script:InstallRoot -UserSid (Get-PharmFarmCurrentUserSid)
    # Model 1.4.0 direct-PowerShell tasks to exercise the actual migration.
    [xml]$legacyXml = $xml
    $legacyXml.Task.Actions.Exec.Command = Get-PharmFarmPowerShellPath
    $legacyXml.Task.Actions.Exec.Arguments = '-NoProfile -File "' + (Join-Path $script:InstallRoot $definition.Script) + '"'
    $xml = $legacyXml.OuterXml
    $script:MockTasks[$definition.Name] = [pscustomobject]@{ Xml = $xml }
  }
  $script:OriginalConfig = [IO.File]::ReadAllText((Join-Path $script:InstallRoot "agent.config.json"))
  $script:SnapshotCount = 0
  $script:RegistrationCount = 0
  $script:FailRegistrationAt = 0
  $script:FailStop = $false
}

function Assert-PreservedData {
  param([switch]$ConfigChanged)
  if (!$ConfigChanged) {
    Assert-Update ([IO.File]::ReadAllText((Join-Path $script:InstallRoot "agent.config.json")) -eq $script:OriginalConfig) "Config bytes are preserved."
  }
  foreach ($directory in @("queue", "sync-state")) {
    Assert-Update ([IO.File]::ReadAllText((Join-Path (Join-Path $script:InstallRoot $directory) "fixture.json")) -eq "unchanged:$directory") "$directory is preserved."
  }
}

function Assert-ControlBytesPreserved {
  foreach ($file in $script:OriginalControls.Keys) {
    Assert-Update ([IO.File]::ReadAllText((Join-Path (Join-Path $script:InstallRoot "lifecycle") $file)) -eq $script:OriginalControls[$file]) "$file bytes are preserved."
  }
}

function Assert-FailedUpdateQuarantined {
  Assert-Update (Test-Path -LiteralPath (Join-Path $script:InstallRoot "lifecycle/maintenance.json")) "Failure retains maintenance marker."
  $owner = Enter-PharmFarmLock -InstallRoot $script:InstallRoot -Name "maintenance-owner"
  Assert-Update ($null -ne $owner) "Failure releases maintenance ownership for explicit repair."
  Exit-PharmFarmLock $owner
  foreach ($task in @(Get-PharmFarmTaskSnapshot)) {
    if ($task.Exists) {
      [xml]$document = $task.Xml
      Assert-Update ([string]$document.Task.Settings.Enabled -eq "false") "Legacy tasks remain disabled after rollback."
    }
  }
  Assert-Update (!(Test-Path -LiteralPath (Join-Path $script:StartupRoot "PharmFarmAgent.lnk"))) "Legacy Startup launch cannot bypass maintenance marker."
}

try {
  New-UpdateFixture "successful-repair"
  $result = Invoke-PharmFarmRuntimeUpdate -SourceRoot $script:SourceRoot -InstallRoot $script:InstallRoot
  Assert-Update ($result.Tasks.Count -eq 3) "All three tasks are verified."
  Assert-Update ($script:SnapshotCount -ge 5) "Snapshot is refreshed inside maintenance and tasks are read back."
  Assert-Update (!(Test-Path -LiteralPath (Join-Path $script:InstallRoot "lifecycle/maintenance.json"))) "Successful repair clears maintenance."
  Assert-Update ([IO.File]::ReadAllText((Join-Path $script:InstallRoot "PharmFarm-Agent.ps1")) -eq "updated:PharmFarm-Agent.ps1") "Updated runtime is copied."
  Assert-Update (Test-Path -LiteralPath (Join-Path $result.BackupRoot "files/agent.config.json")) "Existing configuration is backed up."
  Assert-Update (Test-Path -LiteralPath (Join-Path $result.BackupRoot "startup/PharmFarmAgent.lnk")) "Legacy shortcuts are backed up."
  Assert-Update (Test-Path -LiteralPath (Join-Path $script:StartupRoot 'PharmFarmAgentSupervisor.lnk')) 'Independent same-user Startup entry is installed.'
  Assert-PreservedData
  Assert-ControlBytesPreserved

  Assert-PharmFarmTaskIdentity -Snapshot @(Get-PharmFarmTaskSnapshot) -UserSid (Get-PharmFarmCurrentUserSid) -InstallRoot $script:InstallRoot
  Assert-Update ($true) 'Updated launcher tasks are accepted for a subsequent repair.'
  [xml]$invalidHost = $script:MockTasks.PharmFarmAgent.Xml
  $invalidHost.Task.Actions.Exec.Arguments = '-Role tray'
  $script:MockTasks.PharmFarmAgent.Xml = $invalidHost.OuterXml
  $invalidRejected = $false
  try { Assert-PharmFarmTaskIdentity -Snapshot @(Get-PharmFarmTaskSnapshot) -UserSid (Get-PharmFarmCurrentUserSid) -InstallRoot $script:InstallRoot }
  catch { $invalidRejected = $true }
  Assert-Update $invalidRejected 'Wrong launcher role is rejected before repair.'

  New-UpdateFixture "failed-registration"
  # The first two writes disable the old tasks before copying; fail on the second
  # protected task registration after the runtime files were actually replaced.
  $script:FailRegistrationAt = 4
  $errorText = ""
  try { Invoke-PharmFarmRuntimeUpdate -SourceRoot $script:SourceRoot -InstallRoot $script:InstallRoot | Out-Null }
  catch { $errorText = $_.Exception.Message }
  Assert-Update ($errorText -match "Injected registration failure") "Failed registration is surfaced."
  Assert-Update ([IO.File]::ReadAllText((Join-Path $script:InstallRoot "PharmFarm-Agent.ps1")) -eq "original:PharmFarm-Agent.ps1") "Failed update restores old runtime bytes."
  Assert-Update (!(Test-Path -LiteralPath (Join-Path $script:InstallRoot "PharmFarm-AgentWatchdog.ps1"))) "Files introduced by failed update are removed."
  Assert-Update (!$script:MockTasks.ContainsKey("PharmFarmAgentWatchdog")) "New watchdog task is removed on rollback."
  Assert-FailedUpdateQuarantined
  Assert-PreservedData
  Assert-ControlBytesPreserved

  New-UpdateFixture "failed-stop"
  $script:FailStop = $true
  $errorText = ""
  try { Invoke-PharmFarmRuntimeUpdate -SourceRoot $script:SourceRoot -InstallRoot $script:InstallRoot | Out-Null }
  catch { $errorText = $_.Exception.Message }
  Assert-Update ($errorText -match "processes may still be running") "Unverified stop is reported without claiming processes stopped."
  Assert-Update ([IO.File]::ReadAllText((Join-Path $script:InstallRoot "PharmFarm-Agent.ps1")) -eq "original:PharmFarm-Agent.ps1") "Stop failure never copies runtime files."
  Assert-FailedUpdateQuarantined
  Assert-PreservedData

  New-UpdateFixture "failed-reset-controls"
  $errorText = ""
  try {
    Invoke-PharmFarmRuntimeUpdate -SourceRoot $script:SourceRoot -InstallRoot $script:InstallRoot -ResetControls -Configure {
      [IO.File]::WriteAllText((Join-Path $script:InstallRoot "agent.config.json"), "replacement-config")
    } -Validate { throw "Injected validation failure after controls reset." } | Out-Null
  } catch { $errorText = $_.Exception.Message }
  Assert-Update ($errorText -match "Injected validation failure") "Late installer failure is surfaced."
  Assert-ControlBytesPreserved
  Assert-PreservedData
  Assert-FailedUpdateQuarantined

  New-UpdateFixture "external-config-change"
  try {
    Invoke-PharmFarmRuntimeUpdate -SourceRoot $script:SourceRoot -InstallRoot $script:InstallRoot -Validate {
      [IO.File]::WriteAllText((Join-Path $script:InstallRoot "agent.config.json"), "external-edit")
      throw "External configuration changed."
    } | Out-Null
  } catch { }
  Assert-Update ([IO.File]::ReadAllText((Join-Path $script:InstallRoot "agent.config.json")) -eq "external-edit") "Repair rollback does not overwrite externally changed config."
  Assert-PreservedData -ConfigChanged
  Assert-FailedUpdateQuarantined

  New-UpdateFixture "different-account"
  $script:MockTasks.PharmFarmAgent.Xml = $script:MockTasks.PharmFarmAgent.Xml.Replace("S-1-5-21-111-222-333-1001", "S-1-5-21-111-222-333-1002")
  $errorText = ""
  try { Invoke-PharmFarmRuntimeUpdate -SourceRoot $script:SourceRoot -InstallRoot $script:InstallRoot | Out-Null }
  catch { $errorText = $_.Exception.Message }
  Assert-Update ($errorText -match "different Windows user") "Different installation user is rejected."
  Assert-Update (!(Test-Path -LiteralPath (Join-Path $script:InstallRoot "lifecycle/maintenance.json"))) "Wrong-account rejection occurs before lifecycle changes."
  Assert-PreservedData

  foreach ($variant in @("different-script", "different-config", "host-command")) {
    New-UpdateFixture $variant
    [xml]$otherTask = $script:MockTasks.PharmFarmAgent.Xml
    if ($variant -eq "different-script") {
      $otherTask.Task.Actions.Exec.Arguments = '-NoProfile -File "/some-other-installation/PharmFarm-Agent.ps1"'
    } elseif ($variant -eq "different-config") {
      $otherTask.Task.Actions.Exec.Arguments = '-NoProfile -File "' + (Join-Path $script:InstallRoot "PharmFarm-Agent.ps1") + '" -ConfigPath "/some-other-installation/agent.config.json"'
    } else {
      $otherTask.Task.Actions.Exec.Arguments = '-Command "Get-Date"'
    }
    $script:MockTasks.PharmFarmAgent.Xml = $otherTask.OuterXml
    $errorText = ""
    try { Invoke-PharmFarmRuntimeUpdate -SourceRoot $script:SourceRoot -InstallRoot $script:InstallRoot | Out-Null }
    catch { $errorText = $_.Exception.Message }
    Assert-Update ($errorText -match "different installation|different -ConfigPath") "$variant is rejected before repair."
    Assert-Update ($script:RegistrationCount -eq 0) "$variant never mutates registered tasks."
    Assert-Update (!(Test-Path -LiteralPath (Join-Path $script:InstallRoot "lifecycle/maintenance.json"))) "$variant never acquires maintenance or stops processes."
    Assert-PreservedData
  }

  Write-Host "PASS: $($script:Assertions) update transaction assertions. No Windows task or real agent was executed."
} finally {
  # Exact test-owned directory only; never touch a real installed agent.
  if (Test-Path -LiteralPath $script:TestRoot) { Remove-Item -LiteralPath $script:TestRoot -Recurse -Force }
}
