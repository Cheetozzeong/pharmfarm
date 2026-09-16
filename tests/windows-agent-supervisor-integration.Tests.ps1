param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
# Windows test machine/CI only. No real pharmacy data, SQL, API, OS service stops or logoff.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows integration requires a Windows test environment.' }
$package = Join-Path $RepositoryRoot 'windows-agent-production'
. (Join-Path $package 'PharmFarm-AgentLifecycle.ps1')
. (Join-Path $package 'PharmFarm-AgentTasks.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-supervisor-integration-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$taskName = 'PharmFarmSupervisorTest-' + [guid]::NewGuid().ToString('N')
$registeredTestTask = $false
$checks = 0
function Assert-Test([bool]$Value, [string]$Message) {
  if (!$Value) { throw $Message }
  $script:checks++
  Write-Host "PASS: $Message"
}
function Wait-Test([scriptblock]$Condition, [string]$Message, [int]$Seconds = 35) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out: $Message"
}
function Get-FixtureProcess([string]$Role) {
  $path = Join-Path $root ($Role + '.pid')
  if (!(Test-Path -LiteralPath $path)) { return $null }
  $number = 0
  if (![int]::TryParse([IO.File]::ReadAllText($path), [ref]$number)) { return $null }
  return Get-Process -Id $number -ErrorAction SilentlyContinue
}
function Age-FixtureBudget([string]$Role) {
  # Simulate elapsed cooldown without changing OS time or waiting a whole minute.
  [IO.File]::WriteAllText((Join-Path $root ('lifecycle/supervisor-' + $Role + '.retry')), [DateTime]::UtcNow.AddMinutes(-2).Ticks.ToString())
}
function Find-Supervisor {
  @(Get-PharmFarmProcesses -InstallRoot $root -Roles supervisor -IncludeLaunchers)
}
try {
  Copy-Item (Join-Path $package 'PharmFarm-AgentHost.exe') $root
  Copy-Item (Join-Path $package 'PharmFarm-AgentLifecycle.ps1') $root
  $fixture = @'
param($ConfigPath, $InstallRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PharmFarm-AgentLifecycle.ps1')
$role = if ($ConfigPath) { 'agent' } else { 'tray' }
$lease = Enter-PharmFarmLock -InstallRoot $PSScriptRoot -Name $role
if ($null -eq $lease) { exit 0 }
try {
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot ($role + '.pid')), [string]$PID)
  while ($true) {
    if ($role -eq 'agent' -and !(Test-Path (Join-Path $PSScriptRoot 'hang.fixture'))) {
      Write-PharmFarmProgress -InstallRoot $PSScriptRoot -Phase 'test-no-network'
    }
    Start-Sleep -Milliseconds 200
  }
} finally { $lease.Dispose() }
'@
  foreach ($file in @('PharmFarm-Agent.ps1','PharmFarm-AgentTray.ps1')) {
    [IO.File]::WriteAllText((Join-Path $root $file), $fixture)
  }
  $hostPath = Join-Path $root 'PharmFarm-AgentHost.exe'
  $super = Start-PharmFarmNativeProcess (New-PharmFarmHiddenProcessInfo -FilePath $hostPath -Arguments @('-Role','supervisor') -WorkingDirectory $root)
  Wait-Test { $null -ne (Get-FixtureProcess agent) -and $null -ne (Get-FixtureProcess tray) } 'supervisor starts both fixtures without Scheduler'
  $collector = Get-FixtureProcess agent
  $collectorId = $collector.Id
  $tray = Get-FixtureProcess tray
  Assert-Test ($super.MainWindowHandle -eq [IntPtr]::Zero -and $collector.MainWindowHandle -eq [IntPtr]::Zero -and $tray.MainWindowHandle -eq [IntPtr]::Zero) 'Native supervisor and collector/tray fixtures have no console window'
  $cpuBefore = $super.TotalProcessorTime
  $memoryBefore = $super.WorkingSet64
  Start-Sleep -Seconds 22
  $super.Refresh()
  Assert-Test ((Get-FixtureProcess agent).Id -eq $collectorId) 'Healthy/no-network collector is not restarted across multiple checks'
  $delta = ($super.TotalProcessorTime - $cpuBefore).TotalMilliseconds
  Write-Host ("MEASURE idle supervisor CPU={0:N1}ms/22s, workingSet={1:N1}MiB" -f $delta, ($super.WorkingSet64 / 1MB))
  $watchdog = Invoke-PharmFarmHiddenNative -FilePath $hostPath -Arguments @('-Role','watchdog')
  Assert-Test ($watchdog.ExitCode -eq 0 -and (Find-Supervisor).Count -eq 1) 'Backup tick does not spawn another supervisor when healthy'
  $duplicate = Invoke-PharmFarmHiddenNative -FilePath $hostPath -Arguments @('-Role','supervisor')
  Assert-Test ($duplicate.ExitCode -eq 0 -and (Find-Supervisor).Count -eq 1) 'Simultaneous login/manual start obeys singleton'

  Age-FixtureBudget agent
  [void]$collector.Handle
  $collector.Kill(); [void]$collector.WaitForExit(5000)
  Wait-Test { $p = Get-FixtureProcess agent; $null -ne $p -and $p.Id -ne $collectorId } 'dead collector recovers without Scheduler'
  $collector.Dispose(); $collector = Get-FixtureProcess agent; $collectorId = $collector.Id
  Assert-Test ($collectorId -gt 0) 'Independent supervision restarts a dead collector'
  Set-PharmFarmPaused -InstallRoot $root -Role agent -Paused $true
  [void]$collector.Handle; $collector.Kill(); [void]$collector.WaitForExit(5000)
  Start-Sleep -Seconds 12
  Assert-Test ($null -eq (Get-FixtureProcess agent)) 'Intentional pause prevents automatic restart'
  Set-PharmFarmPaused -InstallRoot $root -Role agent -Paused $false
  $maintenance = Enter-PharmFarmMaintenance -InstallRoot $root -Reason 'isolated-test'
  Age-FixtureBudget agent
  Start-Sleep -Seconds 12
  Assert-Test ($null -eq (Get-FixtureProcess agent)) 'Maintenance blocks recovery even when retry budget allows it'
  Exit-PharmFarmMaintenance -InstallRoot $root -Lease $maintenance -Success
  $maintenance = $null
  Wait-Test { $null -ne (Get-FixtureProcess agent) } 'resume after maintenance'

  # Kill only this fixture supervisor. Its children must NOT die with it.
  $collector = Get-FixtureProcess agent; $collectorId = $collector.Id
  $super.Kill(); [void]$super.WaitForExit(5000)
  Assert-Test ($null -ne (Get-FixtureProcess agent) -and $null -ne (Get-FixtureProcess tray)) 'Collector and tray survive supervisor termination'
  Age-FixtureBudget supervisor

  # A unique temporary real Scheduler task verifies breakaway from its actual Job.
  # Never stop the Windows Schedule service or touch PharmFarm production tasks.
  $xml = New-PharmFarmTaskXml -Role watchdog -InstallRoot $root -UserSid (Get-PharmFarmCurrentUserSid)
  Register-PharmFarmTaskXml -TaskName $taskName -Xml $xml | Out-Null
  $registeredTestTask = $true
  Start-ScheduledTask -TaskName $taskName
  Wait-Test { (Find-Supervisor).Count -eq 1 } 'Scheduler backup launches a detached supervisor'
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 12
  Assert-Test ((Find-Supervisor).Count -eq 1 -and (Get-FixtureProcess agent).Id -eq $collectorId) 'Detached supervisor and healthy collector survive ending the backup task'

  # Exercise real safe-stop/WMI identity path with a simulated future observation
  # (never change OS time). Its 60s confirmation still runs against a real Stopwatch.
  foreach ($entry in Find-Supervisor) { Stop-Process -Id $entry.ProcessId -Force }
  Wait-Test { !(Test-PharmFarmRuntimeLocked -InstallRoot $root -Role supervisor) } 'fixture supervisor stopped'
  [IO.File]::WriteAllText((Join-Path $root 'hang.fixture'), 'fixture only')
  Start-Sleep -Seconds 1
  $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($hostPath))
  $type = $assembly.GetType('PharmFarmSupervisor')
  $checkRole = $type.GetMethod('CheckRole', [Reflection.BindingFlags]'NonPublic,Static')
  $future = [DateTime]::UtcNow.AddMinutes(16)
  $state = $checkRole.Invoke($null, @([string]$root, 'agent', $future))
  Assert-Test ($state -eq 'stale-confirming') 'Stale sample alone never immediately kills a live collector'
  Start-Sleep -Seconds 61
  $state = $checkRole.Invoke($null, @([string]$root, 'agent', $future.AddSeconds(61)))
  Assert-Test ($state -eq 'stale-restart-requested') 'Confirmed stalled exact-identity collector is safely restarted'
  Wait-Test { $p=Get-FixtureProcess agent; $null -ne $p -and $p.Id -ne $collectorId } 'stalled collector replacement'
  Assert-Test ((Get-FixtureProcess agent).Id -ne $collectorId) 'Stalled collector gets a new process, not a duplicate'
  Write-Host "Passed $checks real Windows supervisor assertions. Visual pharmacy desktop verification is still a separate approval step."
} catch {
  Get-ChildItem (Join-Path $root 'logs/*.log') -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName -Tail 30 }
  throw
} finally {
  if ($null -ne $maintenance) { Exit-PharmFarmMaintenance -InstallRoot $root -Lease $maintenance -Success }
  Set-PharmFarmDisabled -InstallRoot $root -Disabled $true
  if ($registeredTestTask) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Stop-PharmFarmProcesses -InstallRoot $root -Roles @('supervisor','agent','tray') -SkipScheduledTasks
  if ($null -ne $super) { $super.Dispose() }
  if ($null -ne $collector) { $collector.Dispose() }
  if ($null -ne $tray) { $tray.Dispose() }
  Remove-Item -LiteralPath $root -Recurse -Force
}
