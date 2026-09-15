param(
  [string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent),
  [switch]$ParseOnly,
  [ValidateSet('', 'hold-agent', 'try-agent', 'start-agent', 'start-tray', 'start-watchdog', 'watchdog-scenario')]
  [string]$ChildMode = '',
  [string]$ChildRoot = '',
  [string]$ChildReady = '',
  [string]$ChildToken = ''
)

# No Pester/global install is needed. macOS PowerShell validates pure lifecycle
# behavior and syntax, not Windows PowerShell 5.1 / Task Scheduler / WinForms.
$ErrorActionPreference = 'Stop'
$productionRoot = Join-Path $RepositoryRoot 'windows-agent-production'
$lifecyclePath = Join-Path $productionRoot 'PharmFarm-AgentLifecycle.ps1'

if ($ChildMode) {
  . $lifecyclePath
  if ($ChildMode -eq 'watchdog-scenario') {
    $scenario = $ChildToken
    $global:pharmFarmWatchdogMock = @{
      Scenario = $scenario; Root = $ChildRoot
      TaskStarts = New-Object 'System.Collections.Generic.List[object]'
      ProcessStarts = New-Object 'System.Collections.Generic.List[object]'
      Locks = New-Object 'System.Collections.Generic.List[object]'
    }
    $env:SystemRoot = Join-Path $ChildRoot 'mock-windows'
    New-Item -ItemType Directory -Path $ChildRoot -Force | Out-Null
    if ($scenario -ne 'missing-config') { Set-Content -LiteralPath (Join-Path $ChildRoot 'agent.config.json') -Value '{}' }
    foreach ($name in @('PharmFarm-Agent.ps1', 'PharmFarm-AgentTray.ps1', 'PharmFarm-AgentHost.exe')) { Set-Content -LiteralPath (Join-Path $ChildRoot $name) -Value '# mock' }
    function Start-Sleep { param($Seconds, $Milliseconds) }
    function Get-CimInstance {
      param($ClassName, $Filter, $ErrorAction)
      if ($global:pharmFarmWatchdogMock.Scenario -eq 'probe-failure') { throw 'simulated CIM access failure' }
      return @()
    }
    function Get-WmiObject { param($Class, $Filter, $ErrorAction) throw 'simulated WMI access failure' }
    function Start-ScheduledTask {
      param($TaskName, $ErrorAction)
      $global:pharmFarmWatchdogMock.TaskStarts.Add($TaskName)
      $role = if ($TaskName -eq 'PharmFarmAgent') { 'agent' } else { 'tray' }
      if ($global:pharmFarmWatchdogMock.Scenario -eq 'fallback' -or $global:pharmFarmWatchdogMock.Scenario -eq 'start-failure') { throw 'simulated task launch failure' }
      if ($global:pharmFarmWatchdogMock.Scenario -eq 'race-pause' -and $role -eq 'agent') {
        Set-PharmFarmPaused -InstallRoot $global:pharmFarmWatchdogMock.Root -Role agent -Paused $true
        return
      }
      $global:pharmFarmWatchdogMock.Locks.Add((Enter-PharmFarmRuntime -InstallRoot $global:pharmFarmWatchdogMock.Root -Role $role))
    }
    function Start-PharmFarmNativeProcess {
      param($Info)
      if ($Info.UseShellExecute -or !$Info.CreateNoWindow) { throw 'Fallback must never create a console.' }
      $global:pharmFarmWatchdogMock.ProcessStarts.Add($Info.Arguments)
      if ($global:pharmFarmWatchdogMock.Scenario -eq 'start-failure') { throw 'simulated direct launch failure' }
      $role = if ($Info.Arguments -match '"tray"') { 'tray' } else { 'agent' }
      $global:pharmFarmWatchdogMock.Locks.Add((Enter-PharmFarmRuntime -InstallRoot $global:pharmFarmWatchdogMock.Root -Role $role))
      $native = [pscustomobject]@{}
      $native | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
      return $native
    }
    if ($scenario -eq 'running') {
      foreach ($role in @('agent', 'tray')) { $global:pharmFarmWatchdogMock.Locks.Add((Enter-PharmFarmRuntime -InstallRoot $ChildRoot -Role $role)) }
    }
    if ($scenario -eq 'paused-agent') { Set-PharmFarmPaused -InstallRoot $ChildRoot -Role agent -Paused $true }
    if ($scenario -eq 'maintenance') { $mockLease = Enter-PharmFarmMaintenance -InstallRoot $ChildRoot -Reason 'test repair' }
    if ($scenario -eq 'disabled') { Set-PharmFarmDisabled -InstallRoot $ChildRoot -Disabled $true }
    if ($scenario -eq 'duplicate-watchdog') { $global:pharmFarmWatchdogMock.Locks.Add((Enter-PharmFarmRuntime -InstallRoot $ChildRoot -Role watchdog)) }
    try {
      # Lifecycle was loaded above before installing the native-process test seam.
      # Skip only its second dot-source; run the complete watchdog body unchanged.
      $watchdogCode = [IO.File]::ReadAllText((Join-Path $productionRoot 'PharmFarm-AgentWatchdog.ps1')) -replace '(?m)^\. \(Join-Path \$PSScriptRoot "PharmFarm-AgentLifecycle.ps1"\)\r?$', ''
      $watchdogHarness = Join-Path $ChildRoot 'watchdog-harness.ps1'
      [IO.File]::WriteAllText($watchdogHarness, $watchdogCode)
      & $watchdogHarness -InstallRoot $ChildRoot
      $watchdogExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
      @{ exitCode = $watchdogExitCode; taskStarts = $global:pharmFarmWatchdogMock.TaskStarts.ToArray(); processStarts = $global:pharmFarmWatchdogMock.ProcessStarts.ToArray() } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ChildRoot 'mock-summary.json')
    } finally {
      foreach ($mockLock in $global:pharmFarmWatchdogMock.Locks) { Exit-PharmFarmLock $mockLock }
      if ($mockLease) { Exit-PharmFarmMaintenance -InstallRoot $ChildRoot -Lease $mockLease -Success }
    }
    exit 0
  }
  if ($ChildMode -eq 'hold-agent') {
    $handle = Enter-PharmFarmRuntime -InstallRoot $ChildRoot -Role agent
    if ($null -eq $handle) { exit 21 }
    try {
      Set-Content -LiteralPath $ChildReady -Value 'ready'
      Start-Sleep -Seconds 30
    } finally { Exit-PharmFarmLock -Handle $handle }
    exit 0
  }
  if ($ChildMode -eq 'try-agent') {
    $handle = Enter-PharmFarmRuntime -InstallRoot $ChildRoot -Role agent -MaintenanceToken $ChildToken
    if ($null -eq $handle) { exit 22 }
    Exit-PharmFarmLock -Handle $handle
    exit 0
  }
  $role = $ChildMode.Substring('start-'.Length)
  if (Test-PharmFarmStartAllowed -InstallRoot $ChildRoot -Role $role -MaintenanceToken $ChildToken) { exit 0 }
  exit 23
}

$script:assertions = 0
function Assert-That {
  param([bool]$Condition, [string]$Message)
  if (!$Condition) { throw "FAIL: $Message" }
  $script:assertions++
  Write-Host "PASS: $Message"
}
function Assert-Throws {
  param([scriptblock]$Action, [string]$Message)
  $didThrow = $false
  try { & $Action | Out-Null } catch { $didThrow = $true }
  Assert-That $didThrow $Message
}

foreach ($file in @(Get-ChildItem -LiteralPath $productionRoot -Filter '*.ps1' -File)) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  Assert-That (@($errors).Count -eq 0) ("PowerShell parser: " + $file.Name + $(if ($errors) { ' ' + ($errors.Message -join '; ') }))
  # These operators are accepted by PS7 but are not available in Windows PS5.1.
  $modernOperators = @($tokens | Where-Object { $_.Kind.ToString() -in @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr') })
  Assert-That ($modernOperators.Count -eq 0) ("No PS7-only operators: " + $file.Name)
  $modernAst = @($ast.FindAll({ param($node) $node.GetType().Name -in @('TernaryExpressionAst', 'PipelineChainAst') }, $true))
  Assert-That ($modernAst.Count -eq 0) ("No PS7-only expression AST: " + $file.Name)
}
if ($ParseOnly) {
  Write-Host "Passed $script:assertions syntax assertions. This is not a Windows 5.1 integration test."
  exit 0
}

. $lifecyclePath
. (Join-Path $productionRoot 'PharmFarm-AgentTasks.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-lifecycle-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$script:childProcesses = @()
$script:heldHandles = @()
$script:leases = @()
$powerShellExecutable = (Get-Process -Id $PID).Path

function ConvertTo-PSLiteral {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}
function Start-TestChild {
  param([string]$Mode, [string]$Root, [string]$Ready = '', [string]$Token = '')
  $command = '& ' + (ConvertTo-PSLiteral $PSCommandPath) + ' -RepositoryRoot ' + (ConvertTo-PSLiteral $RepositoryRoot) +
    ' -ChildMode ' + (ConvertTo-PSLiteral $Mode) + ' -ChildRoot ' + (ConvertTo-PSLiteral $Root) +
    ' -ChildReady ' + (ConvertTo-PSLiteral $Ready) + ' -ChildToken ' + (ConvertTo-PSLiteral $Token) + '; exit $LASTEXITCODE'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $process = Start-Process -FilePath $powerShellExecutable -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', $encoded) -PassThru
  $script:childProcesses += $process
  return $process
}
function Get-TestChildExit {
  param([string]$Mode, [string]$Root, [string]$Token = '')
  $process = Start-TestChild -Mode $Mode -Root $Root -Token $Token
  if (!$process.WaitForExit(10000)) { $process.Kill(); throw "Child test timed out: $Mode" }
  return $process.ExitCode
}

try {
  $roles = @('agent', 'tray', 'watchdog')
  foreach ($role in $roles) {
    Assert-That (Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role $role) "Fresh install allows $role"
    $handle = Enter-PharmFarmRuntime -InstallRoot $testRoot -Role $role
    Assert-That ($null -ne $handle) "First $role instance obtains a retained handle"
    $script:heldHandles += $handle
    Assert-That (Test-PharmFarmRuntimeLocked -InstallRoot $testRoot -Role $role) "Held $role instance is detected"
    $duplicate = Enter-PharmFarmRuntime -InstallRoot $testRoot -Role $role
    if ($duplicate) { $script:heldHandles += $duplicate }
    Assert-That ($null -eq $duplicate) "Second $role instance is rejected"
    Exit-PharmFarmLock -Handle $handle
    Assert-That (!(Test-PharmFarmRuntimeLocked -InstallRoot $testRoot -Role $role)) "Released $role file is not mistaken for a running process"
  }

  $ready = Join-Path $testRoot 'child.ready'
  $holder = Start-TestChild -Mode hold-agent -Root $testRoot -Ready $ready
  $deadline = (Get-Date).AddSeconds(10)
  while (!(Test-Path -LiteralPath $ready) -and (Get-Date) -lt $deadline -and !$holder.HasExited) { Start-Sleep -Milliseconds 50 }
  Assert-That (Test-Path -LiteralPath $ready) 'Independent agent process acquired the lock'
  Assert-That (Test-PharmFarmRuntimeLocked -InstallRoot $testRoot -Role agent) 'Parent detects lock held by independent process'
  Assert-That ((Get-TestChildExit -Mode try-agent -Root $testRoot) -eq 22) 'Another process cannot enter while collector owns lock'
  $holder.Kill()
  $holder.WaitForExit()
  Assert-That ((Get-TestChildExit -Mode try-agent -Root $testRoot) -eq 0) 'Process death releases singleton without stale PID cleanup'

  Set-PharmFarmPaused -InstallRoot $testRoot -Role agent -Paused $true
  Assert-That (Test-PharmFarmPaused -InstallRoot $testRoot -Role agent) 'Explicit collector pause is durable'
  Assert-That ((Get-TestChildExit -Mode try-agent -Root $testRoot) -eq 22) 'Collector pause survives a new PowerShell process'
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role tray) 'Collector pause keeps the tray available to the user'
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role watchdog) 'Collector pause allows independent watchdog observation'
  Set-PharmFarmPaused -InstallRoot $testRoot -Role agent -Paused $false
  Assert-That ((Get-TestChildExit -Mode try-agent -Root $testRoot) -eq 0) 'Explicit resume clears pause'
  Set-PharmFarmPaused -InstallRoot $testRoot -Role tray -Paused $true
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role tray)) 'Explicit tray exit can suppress tray recovery'
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent) 'Tray pause does not pause collection'
  Set-PharmFarmPaused -InstallRoot $testRoot -Role tray -Paused $false

  $lease = Enter-PharmFarmMaintenance -InstallRoot $testRoot -Reason 'automated test'
  $script:leases += $lease
  Assert-That ($null -ne $lease -and ![string]::IsNullOrWhiteSpace($lease.Token)) 'Maintenance owns a token and retained lease'
  foreach ($role in $roles) {
    Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role $role)) "Maintenance blocks automatic $role start"
    Assert-That ((Get-TestChildExit -Mode ("start-" + $role) -Root $testRoot) -eq 23) "Maintenance blocks $role in a separate process"
  }
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent -MaintenanceToken 'wrong-token')) 'Incorrect maintenance token cannot enter'
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent -MaintenanceToken $lease.Token) 'Owner-authorized one-shot collector may enter maintenance'
  foreach ($role in @('tray', 'watchdog')) {
    Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role $role -MaintenanceToken $lease.Token)) "Owner token never exempts $role"
  }
  Assert-That ((Get-TestChildExit -Mode try-agent -Root $testRoot -Token $lease.Token) -eq 0) 'Authorized one-shot collector obtains runtime lock in child process'
  $secondLease = $null
  try { $secondLease = Enter-PharmFarmMaintenance -InstallRoot $testRoot -Reason 'concurrent repair' -RecoverStale } catch { }
  if ($secondLease) { $script:leases += $secondLease }
  Assert-That ($null -eq $secondLease) 'RecoverStale cannot take an active maintenance owner lock'

  Set-PharmFarmDisabled -InstallRoot $testRoot -Disabled $true
  foreach ($role in $roles) {
    Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role $role -MaintenanceToken $lease.Token)) "Uninstall disabled marker wins over $role token"
  }
  Set-PharmFarmDisabled -InstallRoot $testRoot -Disabled $false
  $wrongLease = [pscustomobject]@{ Token = 'wrong-token'; Handle = $null }
  try { Exit-PharmFarmMaintenance -InstallRoot $testRoot -Lease $wrongLease -Success } catch { }
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent)) 'Wrong lease cannot remove maintenance suppression'
  Exit-PharmFarmMaintenance -InstallRoot $testRoot -Lease $lease -Success
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent) 'Successful owner cleanup permits collection'

  $failedLease = Enter-PharmFarmMaintenance -InstallRoot $testRoot -Reason 'simulate failed patch'
  $script:leases += $failedLease
  Exit-PharmFarmMaintenance -InstallRoot $testRoot -Lease $failedLease
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent)) 'Failed maintenance leaves automatic collection fail-closed'
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent -MaintenanceToken $failedLease.Token)) 'Released stale lease token does not authorize a collector'
  $implicitReclaim = $null
  try { $implicitReclaim = Enter-PharmFarmMaintenance -InstallRoot $testRoot -Reason 'unapproved recovery' } catch { }
  if ($implicitReclaim) { $script:leases += $implicitReclaim }
  Assert-That ($null -eq $implicitReclaim) 'Failed maintenance is not implicitly reclaimed'
  $recoveredLease = Enter-PharmFarmMaintenance -InstallRoot $testRoot -Reason 'explicit repair retry' -RecoverStale
  $script:leases += $recoveredLease
  Assert-That ($null -ne $recoveredLease -and $recoveredLease.Token -ne $failedLease.Token) 'Explicit stale recovery claims a new ownership token'
  try { Exit-PharmFarmMaintenance -InstallRoot $testRoot -Lease $failedLease -Success } catch { }
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent)) 'Previous owner cannot remove a newer maintenance marker'
  Exit-PharmFarmMaintenance -InstallRoot $testRoot -Lease $recoveredLease -Success
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $testRoot -Role agent) 'Successful explicit recovery permits startup'

  & {
    # Scoped mocks exercise the Windows legacy guard without querying the host.
    . $lifecyclePath
    $originalOS = $env:OS
    $env:OS = 'Windows_NT'
    $global:pharmFarmLegacyMock = @{ Age = -1; Fail = $false }
    function Get-PharmFarmProcesses {
      param($InstallRoot, $Roles, [switch]$IncludeLaunchers)
      if ($global:pharmFarmLegacyMock.Fail) { throw 'simulated process inventory denied' }
      return [pscustomobject]@{ ProcessId = $PID + 100 }
    }
    function Get-Process {
      param($Id, $ErrorAction)
      $timestamp = [datetime]'2026-09-15T12:00:00'
      if ($Id -ne $PID) { $timestamp = $timestamp.AddSeconds($global:pharmFarmLegacyMock.Age) }
      return [pscustomobject]@{ StartTime = $timestamp }
    }
    try {
      $legacy = Enter-PharmFarmRuntime -InstallRoot $testRoot -Role agent
      if ($legacy) { Exit-PharmFarmLock $legacy }
      Assert-That ($null -eq $legacy) 'New collector refuses an older running legacy collector without singleton support'
      Assert-That (!(Test-PharmFarmRuntimeLocked -InstallRoot $testRoot -Role agent)) 'Legacy rejection releases the candidate lock'
      $global:pharmFarmLegacyMock.Age = 1
      $winner = Enter-PharmFarmRuntime -InstallRoot $testRoot -Role agent
      Assert-That ($null -ne $winner) 'Earlier new launcher is not rejected merely because a later contender exists'
      Exit-PharmFarmLock $winner
      $global:pharmFarmLegacyMock.Fail = $true
      Assert-Throws { Enter-PharmFarmRuntime -InstallRoot $testRoot -Role agent } 'Process inventory access errors fail closed during startup'
      Assert-That (!(Test-PharmFarmRuntimeLocked -InstallRoot $testRoot -Role agent)) 'Inventory failure releases singleton for safe retry'
    } finally { $env:OS = $originalOS }
  }

  & {
    . $lifecyclePath
    $installed = Join-Path $testRoot 'PharmFarm-Agent.ps1'
    $config = Join-Path $testRoot 'agent.config.json'
    $package = Join-Path $testRoot 'extracted package/PharmFarm-Agent.ps1'
    $global:pharmFarmProcessMock = @(
      [pscustomobject]@{ ProcessId = 1; CommandLine = "powershell.exe -File `"$installed`"" },
      [pscustomobject]@{ ProcessId = 2; CommandLine = "powershell.exe -File `"$package`" -ConfigPath `"$config`"" },
      [pscustomobject]@{ ProcessId = 3; CommandLine = "powershell.exe -File `"$package`" -ConfigPath `/other/agent.config.json" },
      [pscustomobject]@{ ProcessId = 4; CommandLine = "powershell.exe -File `"$installed.bak`"" },
      [pscustomobject]@{ ProcessId = 5; CommandLine = "powershell.exe -Command Write-Host -File `"$installed`"" },
      [pscustomobject]@{ ProcessId = 6; CommandLine = "powershell.exe -EncodedCommand code -File `"$installed`"" },
      [pscustomobject]@{ ProcessId = $PID; CommandLine = "powershell.exe -File `"$installed`"" }
    )
    function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $global:pharmFarmProcessMock }
    $matches = @(Get-PharmFarmProcesses -InstallRoot $testRoot -Roles @('agent'))
    Assert-That (($matches.ProcessId -join ',') -eq '1,2') 'Process targeting includes exact installed/manual-config scripts only, not unrelated commands or self'
    Assert-That ((Get-PharmFarmCommandArgument 'powershell.exe -FILE "C:\ProgramData\Agent Folder\agent.ps1" -ConfigPath "C:\ProgramData\Agent Folder\agent.config.json"' '-File') -eq 'C:\ProgramData\Agent Folder\agent.ps1') 'Windows command parsing handles quoted spaces and case-insensitive flags'
  }

  & {
    . $lifecyclePath
    $oldProgramData = $env:ProgramData
    $oldOS = $env:OS
    $env:ProgramData = $testRoot
    $defaultInstall = Join-Path $testRoot 'PharmFarmAgent'
    $sourceLauncher = Join-Path $testRoot 'old extracted package/PharmFarm-Agent.ps1'
    $global:pharmFarmAmbiguousMock = @(
      [pscustomobject]@{ ProcessId = $PID + 101; CommandLine = "powershell.exe -File `"$sourceLauncher`" -Console" },
      [pscustomobject]@{ ProcessId = $PID + 102; CommandLine = "powershell.exe -File `"$sourceLauncher`" -ConfigPath `/other/agent.config.json" }
    )
    function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $global:pharmFarmAmbiguousMock }
    function Get-Process {
      param($Id, $ErrorAction)
      return [pscustomobject]@{ StartTime = ([datetime]'2026-09-15T12:00:00').AddSeconds($(if ($Id -eq $PID) { 0 } else { -60 })) }
    }
    try {
      $matches = @(Get-PharmFarmProcesses -InstallRoot $defaultInstall -Roles @('agent'))
      Assert-That ($matches.Count -eq 1 -and $matches[0].ProcessId -eq ($PID + 101)) 'Default installation detects old source launcher with no ConfigPath, but excludes explicit foreign config'
      Assert-That ($matches[0].PharmFarmAmbiguousLegacy -eq $true) 'Default-path legacy source launcher is marked ambiguous, not safe to kill'
      Assert-That (@(Get-PharmFarmProcesses -InstallRoot (Join-Path $testRoot 'another-install') -Roles @('agent')).Count -eq 0) 'Legacy default source launcher is not attributed to a custom installation'
      $env:OS = 'Windows_NT'
      $overlap = Enter-PharmFarmRuntime -InstallRoot $defaultInstall -Role agent
      if ($overlap) { Exit-PharmFarmLock $overlap }
      Assert-That ($null -eq $overlap) 'Older ambiguous default launcher blocks a second collector'
      Assert-That (!(Test-PharmFarmRuntimeLocked -InstallRoot $defaultInstall -Role agent)) 'Ambiguous legacy rejection releases the candidate runtime lock'
    } finally { $env:ProgramData = $oldProgramData; $env:OS = $oldOS }
  }

  & {
    . $lifecyclePath
    function Stop-ScheduledTask {
      param($TaskName, $ErrorAction)
      $global:pharmFarmStopMock.Events.Add('stop-task')
    }
    function Get-PharmFarmProcesses {
      param($InstallRoot, $Roles)
      $global:pharmFarmStopMock.InventoryCalls++
      $global:pharmFarmStopMock.Events.Add('inventory-' + $global:pharmFarmStopMock.InventoryCalls)
      if ($global:pharmFarmStopMock.InventoryCalls -eq 1) { return $global:pharmFarmStopMock.Original }
      if ($global:pharmFarmStopMock.InventoryCalls -gt 2 -or $global:pharmFarmStopMock.Scenario -in @('native-gone', 'gone-on-refresh')) { return @() }
      return $global:pharmFarmStopMock.Fresh
    }
    function Get-Process {
      param($Id, $ErrorAction)
      $global:pharmFarmStopMock.Events.Add('native-process')
      if ($global:pharmFarmStopMock.Scenario -eq 'native-gone') { return $null }
      return $global:pharmFarmStopMock.Native
    }
    foreach ($scenario in @('matching', 'changed-creation', 'changed-command', 'missing-creation', 'fresh-ambiguous', 'original-ambiguous', 'native-gone', 'gone-on-refresh', 'already-exited')) {
      $original = [pscustomobject]@{ ProcessId = 43210; CommandLine = 'powershell.exe -File "C:\ProgramData\PharmFarmAgent\PharmFarm-Agent.ps1"'; CreationDate = '20260915120000.000000+540'; PharmFarmAmbiguousLegacy = $false }
      $fresh = [pscustomobject]@{ ProcessId = $original.ProcessId; CommandLine = $original.CommandLine; CreationDate = $original.CreationDate; PharmFarmAmbiguousLegacy = $false }
      if ($scenario -eq 'changed-creation') { $fresh.CreationDate = '20260915120100.000000+540' }
      if ($scenario -eq 'changed-command') { $fresh.CommandLine += ' -ConfigPath "C:\different\agent.config.json"' }
      if ($scenario -eq 'missing-creation') { $original.CreationDate = $null }
      if ($scenario -eq 'fresh-ambiguous') { $fresh.PharmFarmAmbiguousLegacy = $true }
      if ($scenario -eq 'original-ambiguous') { $original.PharmFarmAmbiguousLegacy = $true }
      $native = [pscustomobject]@{ HasExited = ($scenario -eq 'already-exited') }
      $native | Add-Member -MemberType ScriptProperty -Name Handle -Value { $global:pharmFarmStopMock.Events.Add('handle'); return [IntPtr]1 }
      $native | Add-Member -MemberType ScriptMethod -Name Kill -Value { $global:pharmFarmStopMock.Kills++; $global:pharmFarmStopMock.Events.Add('kill'); $this.HasExited = $true }
      $native | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $global:pharmFarmStopMock.Disposes++; $global:pharmFarmStopMock.Events.Add('dispose') }
      $global:pharmFarmStopMock = @{
        Scenario = $scenario; Original = $original; Fresh = $fresh; Native = $native
        InventoryCalls = 0; Kills = 0; Disposes = 0
        Events = New-Object 'System.Collections.Generic.List[string]'
      }
      $failure = $null
      try { Stop-PharmFarmProcesses -InstallRoot $testRoot -Roles @('agent') } catch { $failure = $_ }
      if ($scenario -eq 'matching') {
        Assert-That ($null -eq $failure -and $global:pharmFarmStopMock.Kills -eq 1) 'Process stop kills an exact same-creation/same-command native process'
        Assert-That ($global:pharmFarmStopMock.Events.IndexOf('handle') -lt $global:pharmFarmStopMock.Events.IndexOf('inventory-2') -and $global:pharmFarmStopMock.Events.IndexOf('inventory-2') -lt $global:pharmFarmStopMock.Events.IndexOf('kill')) 'Process stop acquires native handle, then rechecks identity, then kills'
      } elseif ($scenario -in @('changed-creation', 'changed-command', 'missing-creation', 'fresh-ambiguous', 'original-ambiguous')) {
        Assert-That ($null -ne $failure -and $global:pharmFarmStopMock.Kills -eq 0) "Process stop refuses force-kill for $scenario"
      } else {
        Assert-That ($null -eq $failure -and $global:pharmFarmStopMock.Kills -eq 0) "Process stop skips safely when $scenario"
      }
      if ($scenario -in @('original-ambiguous', 'native-gone')) {
        Assert-That ($global:pharmFarmStopMock.Disposes -eq 0 -and !$global:pharmFarmStopMock.Events.Contains('handle')) "No native handle opened for $scenario"
      } else {
        Assert-That ($global:pharmFarmStopMock.Disposes -eq 1) "Native process handle disposed exactly once for $scenario"
      }
    }
  }

  & {
    . $lifecyclePath
    function Stop-ScheduledTask { param($TaskName, $ErrorAction) throw 'Task does not exist' }
    function Join-Path { param($Path, $ChildPath) return 'Invoke-MissingTaskSchtasks' }
    function Test-Path { param($LiteralPath) return $true }
    function Invoke-PharmFarmHiddenNative { param($FilePath, $Arguments) return [pscustomobject]@{ ExitCode = 1; Output = 'ERROR: The system cannot find the file specified.' } }
    $script:missingTaskInventoryCalls = 0
    function Get-PharmFarmProcesses { param($InstallRoot, $Roles, [switch]$IncludeLaunchers) $script:missingTaskInventoryCalls++; return @() }
    function Test-PharmFarmRuntimeLocked { param($InstallRoot, $Role) return $false }
    Stop-PharmFarmProcesses -InstallRoot $testRoot -Roles @('watchdog', 'agent', 'tray')
    Assert-That ($script:missingTaskInventoryCalls -ge 2) 'Missing legacy task stderr does not skip authoritative process-stop verification'
    Assert-That ($ErrorActionPreference -eq 'Stop') 'Best-effort schtasks stop restores strict error handling'
  }

  $sid = 'S-1-5-21-111111111-222222222-333333333-1001'
  foreach ($definition in @(Get-PharmFarmTaskDefinitions)) {
    $xmlText = New-PharmFarmTaskXml -Role $definition.Role -InstallRoot $testRoot -UserSid $sid -StartAt ([datetime]'2026-09-15T13:15:00')
    [xml]$xml = $xmlText
    Assert-PharmFarmTaskXml -TaskName $definition.Name -ActualXml $xmlText -ExpectedXml $xmlText
    Assert-That ([string]$xml.Task.Principals.Principal.UserId -eq $sid) "$($definition.Name) retains the exact installation user"
    Assert-That ([string]$xml.Task.Principals.Principal.LogonType -eq 'InteractiveToken') "$($definition.Name) never silently becomes SYSTEM or password login"
    $expectedLimit = if ($definition.Role -eq 'watchdog') { 'PT2M' } else { 'PT0S' }
    Assert-That ([string]$xml.Task.Settings.ExecutionTimeLimit -eq $expectedLimit) "$($definition.Name) uses the intended long-running/short-check limit"
    Assert-That ([string]$xml.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew') "$($definition.Name) ignores duplicate scheduler starts"
    Assert-That ([string]$xml.Task.Settings.StartWhenAvailable -eq 'true') "$($definition.Name) can catch up missed starts"
    Assert-That ([string]$xml.Task.Settings.RestartOnFailure.Interval -eq 'PT1M' -and [string]$xml.Task.Settings.RestartOnFailure.Count -eq '3') "$($definition.Name) retries failures three times"
    Assert-That ([string]$xml.Task.Triggers.LogonTrigger.UserId -eq $sid) "$($definition.Name) listens for the same user's logon"
    $modified = $xmlText.Replace(("<ExecutionTimeLimit>" + $expectedLimit + "</ExecutionTimeLimit>"), '<ExecutionTimeLimit>PT72H</ExecutionTimeLimit>')
    Assert-Throws { Assert-PharmFarmTaskXml -TaskName $definition.Name -ActualXml $modified -ExpectedXml $xmlText } "$($definition.Name) rejects reintroduced runtime limit"
    $modified = $xmlText.Replace('<LogonType>InteractiveToken</LogonType>', '<LogonType>ServiceAccount</LogonType>')
    Assert-Throws { Assert-PharmFarmTaskXml -TaskName $definition.Name -ActualXml $modified -ExpectedXml $xmlText } "$($definition.Name) rejects changed login identity type"
    if ($definition.Role -eq 'watchdog') {
      Assert-That ([string]$xml.Task.Triggers.TimeTrigger.Repetition.Interval -eq 'PT1M') 'Independent watchdog repeats every minute'
      Assert-That (!$xml.Task.Triggers.TimeTrigger.Repetition.Duration -and !$xml.Task.Triggers.TimeTrigger.EndBoundary) 'Watchdog repeat does not silently expire'
      $modified = $xmlText.Replace('<Interval>PT1M</Interval><StopAtDurationEnd>', '<Interval>PT1M</Interval><Duration>PT1H</Duration><StopAtDurationEnd>')
      Assert-Throws { Assert-PharmFarmTaskXml -TaskName $definition.Name -ActualXml $modified -ExpectedXml $xmlText } 'Verification rejects an expiring watchdog'
    }
  }

  foreach ($scenario in @('running', 'task-success', 'fallback', 'start-failure', 'paused-agent', 'maintenance', 'disabled', 'duplicate-watchdog', 'missing-config', 'race-pause', 'probe-failure')) {
    $scenarioRoot = Join-Path $testRoot ('watchdog-' + $scenario)
    Assert-That ((Get-TestChildExit -Mode watchdog-scenario -Root $scenarioRoot -Token $scenario) -eq 0) "Watchdog mock harness completed: $scenario"
    $summary = Get-Content -LiteralPath (Join-Path $scenarioRoot 'mock-summary.json') -Raw | ConvertFrom-Json
    $statePath = Join-Path $scenarioRoot 'watchdog.state.json'
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
    switch ($scenario) {
      'running' {
        Assert-That (@($summary.taskStarts).Count -eq 0 -and @($summary.processStarts).Count -eq 0) 'Healthy runtime is not restarted by watchdog'
        Assert-That (@($state.targets | Where-Object { $_.status -eq 'running' }).Count -eq 2) 'Existing collector and tray are recorded running, not server-healthy'
      }
      'task-success' {
        Assert-That (@($summary.taskStarts).Count -eq 2 -and @($summary.processStarts).Count -eq 0) 'Watchdog prefers registered tasks without unnecessary fallback'
        Assert-That (@($state.targets | Where-Object { $_.status -eq 'restarted' }).Count -eq 2) 'Watchdog verifies two runtime recoveries'
      }
      'fallback' {
        Assert-That (@($summary.taskStarts).Count -eq 2 -and @($summary.processStarts).Count -eq 2) 'Failed task starts fall back to direct same-user launch'
        Assert-That (@($state.targets | Where-Object { $_.status -eq 'restarted' }).Count -eq 2) 'Fallback verifies collector and tray are running'
      }
      'start-failure' {
        Assert-That ($summary.exitCode -eq 1 -and @($state.targets | Where-Object { $_.status -eq 'error' }).Count -eq 2) 'Failed launches return nonzero with errors, never false recovery'
      }
      'paused-agent' {
        Assert-That (@($summary.taskStarts).Count -eq 1 -and $summary.taskStarts[0] -eq 'PharmFarmAgentTray') 'Watchdog honors collector pause while restoring tray'
        Assert-That (@($state.targets | Where-Object { $_.role -eq 'agent' })[0].status -eq 'suppressed') 'Paused collector status is suppressed'
      }
      { $_ -in @('maintenance', 'disabled', 'duplicate-watchdog') } {
        Assert-That (@($summary.taskStarts).Count -eq 0 -and @($summary.processStarts).Count -eq 0 -and $summary.exitCode -eq 0) "Watchdog performs no launch during $scenario"
      }
      'missing-config' {
        Assert-That (@($summary.taskStarts).Count -eq 0 -and $summary.exitCode -eq 1) 'Missing configuration fails without launching collection'
      }
      'race-pause' {
        Assert-That (@($summary.processStarts).Count -eq 0 -and @($state.targets | Where-Object { $_.role -eq 'agent' })[0].status -eq 'suppressed') 'Pause arriving after scheduled start blocks direct fallback'
      }
      'probe-failure' {
        Assert-That (@($summary.taskStarts).Count -eq 0 -and @($summary.processStarts).Count -eq 0 -and $summary.exitCode -eq 1) 'Unknown process state fails closed instead of risking duplicate collection'
      }
    }
  }
  Write-Host "Passed $script:assertions assertions. Windows 5.1, Task Scheduler and WinForms still require the approved Windows test window."
} finally {
  foreach ($process in $script:childProcesses) {
    try { if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() } catch { }
  }
  foreach ($handle in $script:heldHandles) { try { Exit-PharmFarmLock -Handle $handle } catch { } }
  foreach ($lease in $script:leases) { try { Exit-PharmFarmLock -Handle $lease.Handle } catch { } }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
