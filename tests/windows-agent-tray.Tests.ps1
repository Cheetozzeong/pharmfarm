param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))

# Execute only AST-extracted functions, never the WinForms startup block. All
# Windows task/process/UI calls below are mocks; no customer or live data is used.
$ErrorActionPreference = 'Stop'
$productionRoot = Join-Path $RepositoryRoot 'windows-agent-production'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $productionRoot 'PharmFarm-AgentTray.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors.Message -join '; ') }
$selectedFunctions = @(
  'Start-AgentTask', 'Stop-AgentTask', 'Test-AgentRuntimeRunning',
  'Invoke-AgentStateReset', 'Request-TodayPrescriptionOverwrite',
  'Invoke-AgentAutoRecovery', 'Request-ReferenceResync', 'Request-ControlledDrugResync',
  'Complete-AgentMaintenance', 'Restart-AgentTask'
)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($definition.Name -in $selectedFunctions) { Invoke-Expression $definition.Extent.Text }
}
. (Join-Path $productionRoot 'PharmFarm-AgentLifecycle.ps1')
$script:realExitMaintenance = (Get-Command Exit-PharmFarmMaintenance).ScriptBlock

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-tray-tests-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$script:assertions = 0
$script:leaseHandles = New-Object 'System.Collections.Generic.List[object]'

function Assert-That {
  param([bool]$Condition, [string]$Message)
  if (!$Condition) { throw "FAIL: $Message" }
  $script:assertions++
  Write-Host "PASS: $Message"
}

function New-Scenario {
  param([string]$Name)
  $script:InstallRoot = Join-Path $testRoot $Name
  [void][IO.Directory]::CreateDirectory($script:InstallRoot)
  $script:AgentScript = Join-Path $script:InstallRoot 'PharmFarm-Agent.ps1'
  $script:ConfigFile = Join-Path $script:InstallRoot 'agent.config.json'
  $script:RecoveryStateFile = Join-Path $script:InstallRoot 'agent.recovery-required.json'
  $script:SyncStateDir = Join-Path $script:InstallRoot 'sync-state'
  $script:BootstrapStateFile = Join-Path $script:InstallRoot 'bootstrap.state.json'
  $script:TaskName = 'PharmFarmAgent'
  [IO.File]::WriteAllText($script:AgentScript, '# never executed')
  $script:mock = @{
    Events = New-Object 'System.Collections.Generic.List[string]'
    Notices = New-Object 'System.Collections.Generic.List[object]'
    StopFails = $false; CleanupFails = $false; ProcessExitCode = 0; RuntimeState = 'Ready'
    TaskStarts = 0; ProcessStarts = 0; MutationCount = 0; ResumeCalls = 0
    LastArguments = ''; StopSawPause = $false; StopSawMaintenance = $false
  }
}

function Show-Balloon {
  param($Title, $Text, $Icon, $DurationMilliseconds)
  $script:mock.Notices.Add(@{ title = $Title; text = $Text; icon = $Icon })
}
function Exit-PharmFarmMaintenance {
  param($InstallRoot, $Lease, [switch]$Success)
  if ($script:mock.CleanupFails) {
    # Model a cleanup failure that leaves the marker but releases ownership,
    # as the real helper does in its finally block.
    & $script:realExitMaintenance -InstallRoot $InstallRoot -Lease $Lease -Success:$false
    throw 'simulated maintenance cleanup failure'
  }
  & $script:realExitMaintenance -InstallRoot $InstallRoot -Lease $Lease -Success:$Success
}
function Stop-PharmFarmProcesses {
  param($InstallRoot, $Roles)
  $script:mock.Events.Add('stop')
  $script:mock.StopSawPause = Test-PharmFarmPaused -InstallRoot $InstallRoot -Role agent
  $script:mock.StopSawMaintenance = Test-Path -LiteralPath (Join-Path $InstallRoot 'lifecycle/maintenance.json')
  if ($script:mock.StopFails) { throw 'simulated agent still running' }
  $script:mock.RuntimeState = 'Ready'
}
function Get-AgentTaskState { return 'Ready' }
function Get-AgentRuntimeState { return $script:mock.RuntimeState }
function Start-ScheduledTask {
  param($TaskName, $ErrorAction)
  $script:mock.Events.Add('start')
  $script:mock.TaskStarts++
}
function Get-PowerShellExe { return $script:AgentScript }
function Start-PharmFarmHiddenRuntime {
  param($InstallRoot, $Role, [switch]$Wait, [switch]$ResyncTodayPrescriptions, $MaintenanceToken)
  $script:mock.Events.Add('resync-process')
  $script:mock.ProcessStarts++
  $script:mock.LastArguments = "-Role $Role -MaintenanceToken `"$MaintenanceToken`""
  if ($ResyncTodayPrescriptions) { $script:mock.LastArguments += ' -ResyncTodayPrescriptions' }
  return [pscustomobject]@{ ExitCode = $script:mock.ProcessExitCode }
}
function Ensure-Directory { param($Path) [void][IO.Directory]::CreateDirectory($Path) }
function Start-Sleep { param($Seconds, $Milliseconds) }
function Set-AgentRecoveryRequired { param($Reason, $State) $script:mock.Events.Add('recovery-marker') }
function Remove-SyncHash {
  param($Kind)
  $script:mock.Events.Add('mutation')
  $script:mock.MutationCount++
}
function Reset-BootstrapFlags {
  param($Keys)
  $script:mock.Events.Add('mutation')
  $script:mock.MutationCount++
}

try {
  New-Scenario 'stop-success'
  Stop-AgentTask
  Assert-That $script:mock.StopSawPause 'Pause marker exists before the collector is stopped'
  Assert-That (Test-PharmFarmPaused -InstallRoot $InstallRoot -Role agent) 'User stop survives tray memory reset'
  Assert-That ($script:mock.Notices[-1].icon -eq 'Warning') 'Confirmed stop reports the intentional stop warning'

  New-Scenario 'stop-failure'
  $script:mock.StopFails = $true
  Stop-AgentTask
  Assert-That (Test-PharmFarmPaused -InstallRoot $InstallRoot -Role agent) 'Failed stop keeps the pause marker rather than enabling watchdog restart'
  Assert-That ($script:mock.Notices[-1].icon -eq 'Error') 'Failed stop does not report successful shutdown'

  New-Scenario 'manual-start-maintenance'
  Set-PharmFarmPaused -InstallRoot $InstallRoot -Role agent -Paused $true
  $lease = Enter-PharmFarmMaintenance -InstallRoot $InstallRoot -Reason 'test-active-maintenance'
  $script:leaseHandles.Add(@{ root = $InstallRoot; lease = $lease })
  $started = Start-AgentTask -Silent
  Assert-That (!$started) 'Manual start is rejected during maintenance'
  Assert-That (Test-PharmFarmPaused -InstallRoot $InstallRoot -Role agent) 'Rejected manual start restores the existing user pause'
  Assert-That ($script:mock.TaskStarts -eq 0 -and $script:mock.ProcessStarts -eq 0) 'Maintenance-blocked manual start launches nothing'
  Exit-PharmFarmMaintenance -InstallRoot $InstallRoot -Lease $lease -Success

  New-Scenario 'manual-resume'
  Set-PharmFarmPaused -InstallRoot $InstallRoot -Role agent -Paused $true
  Assert-That (Start-AgentTask -Silent) 'Explicit start resumes an intentionally paused collector'
  Assert-That (!(Test-PharmFarmPaused -InstallRoot $InstallRoot -Role agent)) 'Successful manual start clears only the collector pause'
  Assert-That ($script:mock.TaskStarts -eq 1) 'Explicit resume starts the collector once'

  New-Scenario 'duplicate-start'
  $script:mock.RuntimeState = 'Running'
  Assert-That (Start-AgentTask -Automatic -Silent) 'An already running collector satisfies the start request'
  Assert-That ($script:mock.TaskStarts -eq 0 -and $script:mock.ProcessStarts -eq 0) 'Duplicate start creates no new process or scheduled invocation'

  New-Scenario 'reset-stop-failure'
  $script:mock.StopFails = $true
  Invoke-AgentStateReset -Label 'test reset' -ResetState { $script:mock.MutationCount++ }
  Assert-That $script:mock.StopSawMaintenance 'Reset establishes maintenance before stopping the collector'
  Assert-That ($script:mock.MutationCount -eq 0) 'Unconfirmed collector stop prevents hash/state mutations'
  Assert-That ($script:mock.TaskStarts -eq 0) 'Failed stop does not restart the collector'
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role agent)) 'Failed stop preserves maintenance suppression'

  New-Scenario 'reset-mutation-failure'
  Invoke-AgentStateReset -Label 'test reset' -ResetState { throw 'simulated state write failure' }
  Assert-That ($script:mock.TaskStarts -eq 0) 'Failed state mutation does not restart the collector'
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role agent)) 'Failed mutation leaves explicit repair required'
  Assert-That ($script:mock.Notices[-1].icon -eq 'Error') 'Failed mutation produces an actionable error notice'

  New-Scenario 'reset-success'
  Invoke-AgentStateReset -Label 'test reset' -ResetState { $script:mock.Events.Add('mutation') }
  Assert-That (($script:mock.Events -join ',') -eq 'stop,mutation,start') 'Successful reset orders stop, mutation, and restart'
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role agent) 'Successful reset clears maintenance'

  New-Scenario 'paused-reset'
  Set-PharmFarmPaused -InstallRoot $InstallRoot -Role agent -Paused $true
  Request-ReferenceResync
  Request-ControlledDrugResync
  Assert-That ($script:mock.MutationCount -eq 0 -and $script:mock.Events.Count -eq 0) 'Both reference resync actions preserve intentional pause without mutation or stop'

  New-Scenario 'resync-nonzero'
  $script:mock.ProcessExitCode = 2
  Assert-That (!(Request-TodayPrescriptionOverwrite)) 'A blocked/nonzero resync does not report completion'
  Assert-That ($script:mock.TaskStarts -eq 0) 'Nonzero resync does not resume a potentially unsafe collector'
  Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role agent)) 'Nonzero resync retains maintenance for explicit repair'
  Assert-That ($script:mock.LastArguments -match '-MaintenanceToken "[a-f0-9]+"') 'One-time resync receives the active maintenance token'
  Assert-That ($script:mock.Notices[-1].icon -eq 'Error') 'Nonzero resync shows failure rather than a completion balloon'

  New-Scenario 'resync-stop-failure'
  $script:mock.StopFails = $true
  Assert-That (!(Request-TodayPrescriptionOverwrite)) 'Resync aborts when collector shutdown cannot be confirmed'
  Assert-That ($script:mock.ProcessStarts -eq 0) 'Unconfirmed stop never launches the resync process'

  New-Scenario 'resync-success'
  Assert-That (Request-TodayPrescriptionOverwrite) 'Zero-exit resync reports queue operation completion'
  Assert-That (($script:mock.Events -join ',') -eq 'stop,resync-process,start') 'Successful today resync stops, queues, and resumes in order'
  Assert-That (Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role agent) 'Successful today resync releases maintenance'

  foreach ($operation in @('restart', 'today', 'state-reset')) {
    foreach ($alsoFailStop in @($false, $true)) {
      New-Scenario ("cleanup-$operation-$alsoFailStop")
      $script:mock.CleanupFails = $true
      $script:mock.StopFails = $alsoFailStop
      [IO.File]::WriteAllText($RecoveryStateFile, '{}')
      $result = switch ($operation) {
        'restart' { Restart-AgentTask }
        'today' { Request-TodayPrescriptionOverwrite }
        'state-reset' { Invoke-AgentStateReset -Label 'test reset' -ResetState { $script:mock.MutationCount++ } }
      }
      if ($operation -ne 'state-reset') {
        Assert-That (!$result) "$operation returns false when maintenance cleanup fails (stop failure=$alsoFailStop)"
      }
      Assert-That ($script:mock.TaskStarts -eq 0) "$operation does not restart after cleanup failure (stop failure=$alsoFailStop)"
      Assert-That (@($script:mock.Notices | Where-Object { $_.icon -ne 'Error' }).Count -eq 0) "$operation never shows completion/success after cleanup failure (stop failure=$alsoFailStop)"
      Assert-That ($script:mock.Notices[-1].text -match 'repair-pharmfarm-agent.bat') "$operation cleanup failure explains the repair action (stop failure=$alsoFailStop)"
      Assert-That ($script:mock.Notices[-1].text -match 'simulated maintenance cleanup failure') "$operation retains the cleanup error detail (stop failure=$alsoFailStop)"
      Assert-That (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role agent)) "$operation retains fail-safe maintenance suppression (stop failure=$alsoFailStop)"
      if ($alsoFailStop) {
        Assert-That ($script:mock.Notices[-1].text -match 'simulated agent still running') "$operation cleanup notice also preserves the original operation error"
      }
      if ($operation -eq 'today') {
        Assert-That (Test-Path -LiteralPath $RecoveryStateFile) 'Cleanup-failed today resync does not erase the recovery warning'
      }
    }
  }

  foreach ($blockedState in @('Paused', 'Maintenance', 'Unknown', 'Starting')) {
    New-Scenario ('auto-' + $blockedState)
    Assert-That ((Invoke-AgentAutoRecovery -RuntimeState $blockedState -State $null) -eq $blockedState) "Automatic recovery preserves $blockedState"
    Assert-That ($script:mock.Events.Count -eq 0) "Automatic recovery does not launch or write recovery markers for $blockedState"
  }
  Write-Host "Passed $script:assertions tray assertions. Windows WinForms/task integration remains a separate live check."
} finally {
  foreach ($held in $script:leaseHandles) { Exit-PharmFarmLock -Handle $held.lease.Handle }
  # Only this invocation's unique temporary fixture directory is removed.
  if ([IO.Directory]::Exists($testRoot)) { [IO.Directory]::Delete($testRoot, $true) }
}
