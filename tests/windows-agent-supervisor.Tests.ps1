param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$package = Join-Path $RepositoryRoot 'windows-agent-production'
. (Join-Path $package 'PharmFarm-AgentLifecycle.ps1')
$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes((Join-Path $package 'PharmFarm-AgentHost.exe')))
$supervisor = $assembly.GetType('PharmFarmSupervisor', $true)
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$root = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-supervisor-tests-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory((Join-Path $root 'lifecycle'))
$checks = 0
function Assert-Supervisor([bool]$Value, [string]$Message) {
  if (!$Value) { throw $Message }
  $script:checks++
  Write-Host "PASS: $Message"
}
function Invoke-Supervisor([string]$Name, [object[]]$Values) {
  for ($i = 0; $i -lt $Values.Length; $i++) { $Values[$i] = $Values[$i].PSObject.BaseObject }
  $supervisor.GetMethod($Name, $flags).Invoke($null, $Values)
}
try {
  Assert-Supervisor (Invoke-Supervisor Allowed @($root, 'agent')) 'Fresh collector may start'
  foreach ($marker in @('agent.paused.json','maintenance.json','disabled.json')) {
    $path = Join-Path $root ('lifecycle/' + $marker)
    [IO.File]::WriteAllText($path, 'even corrupt intent is respected')
    Assert-Supervisor (!(Invoke-Supervisor Allowed @($root, 'agent'))) "$marker suppresses native recovery"
    Remove-Item -LiteralPath $path
  }
  $lease = Enter-PharmFarmLock -InstallRoot $root -Name supervisor
  try {
    Assert-Supervisor (Invoke-Supervisor Locked @($root, 'supervisor')) 'Native supervisor respects PowerShell singleton lock'
  } finally { $lease.Dispose() }
  $lease = Invoke-Supervisor TryLock @($root, 'supervisor')
  try {
    Assert-Supervisor (Test-PharmFarmRuntimeLocked -InstallRoot $root -Role supervisor) 'PowerShell stop detects native supervisor lock'
  } finally { $lease.Dispose() }
  Assert-Supervisor (!(Invoke-Supervisor Locked @($root, 'supervisor'))) 'Released file is not a false running process'
  $now = [DateTime]::UtcNow
  Assert-Supervisor (Invoke-Supervisor ReserveAttempt @($root,'agent',$now)) 'First recovery is allowed'
  Assert-Supervisor (!(Invoke-Supervisor ReserveAttempt @($root,'agent',$now.AddSeconds(10)))) 'Immediate retries are blocked'
  Assert-Supervisor (Invoke-Supervisor ReserveAttempt @($root,'agent',$now.AddMinutes(1))) 'Second retry after cooldown'
  Assert-Supervisor (Invoke-Supervisor ReserveAttempt @($root,'agent',$now.AddMinutes(2))) 'Third retry after cooldown'
  Assert-Supervisor (!(Invoke-Supervisor ReserveAttempt @($root,'agent',$now.AddMinutes(3)))) 'Persistent 3 per 15 minute budget blocks recovery storm'
  Assert-Supervisor (!(Invoke-Supervisor ReserveAttempt @($root,'agent',$now.AddMinutes(-1)))) 'Clock rollback fails closed'
  Assert-Supervisor (Invoke-Supervisor ReserveAttempt @($root,'agent',$now.AddMinutes(16))) 'Budget becomes available after window expires'
  Assert-Supervisor (Invoke-Supervisor ReserveAttempt @($root,'tray',$now)) 'Roles have independent budgets'
  $bad = Join-Path $root 'lifecycle/supervisor-supervisor.retry'
  [IO.File]::WriteAllText($bad, 'corrupt')
  Assert-Supervisor (!(Invoke-Supervisor ReserveAttempt @($root,'supervisor',$now))) 'Corrupt retry ledger does not erase crash history'

  Write-PharmFarmProgress -InstallRoot $root -Phase 'working'
  $progress = [IO.File]::ReadAllText((Join-Path $root 'lifecycle/agent.progress'))
  $values = @($progress, $now.AddSeconds(10), 0, [long]0)
  Assert-Supervisor (!$supervisor.GetMethod('StaleProgress',$flags).Invoke($null,$values)) 'Fresh progress is healthy even with no API success'
  $values = @($progress, $now.AddSeconds(950), 0, [long]0)
  Assert-Supervisor ($supervisor.GetMethod('StaleProgress',$flags).Invoke($null,$values)) 'Collector progress becomes stale after conservative limit'
  Assert-Supervisor ($values[2] -eq $PID -and $values[3] -gt 0) 'Progress carries PID and process start identity'
  foreach ($badText in @('', 'bad', "1`n0`n1`n2`nwatch", "1`n123`n5`n2`nwatch")) {
    $values = @($badText, $now, 0, [long]0)
    Assert-Supervisor (!$supervisor.GetMethod('StaleProgress',$flags).Invoke($null,$values)) 'Invalid progress never authorizes a kill'
  }
  $values = @($progress, $now.AddHours(-1), 0, [long]0)
  Assert-Supervisor (!$supervisor.GetMethod('StaleProgress',$flags).Invoke($null,$values)) 'Future progress after a clock rollback never authorizes a kill'
  Write-Host "Passed $checks native supervisor policy assertions."
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
