param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
# Windows-only, isolated fake scripts. Never touches ProgramData, real tasks, SQL or APIs.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this integration suite on a Windows test PC, not the pharmacy installation.' }
$package = Join-Path $RepositoryRoot 'windows-agent-production'
. (Join-Path $package 'PharmFarm-AgentLifecycle.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-host-integration-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$owned = New-Object 'System.Collections.Generic.List[object]'
$checks = 0
function Assert-Host([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
  $script:checks++
  Write-Host "PASS: $Message"
}
function Wait-TestFile([string]$Path) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (!(Test-Path -LiteralPath $Path)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw "Fixture timed out: $Path" }
    Start-Sleep -Milliseconds 100
  }
}
try {
  $hostPath = Join-Path $testRoot 'PharmFarm-AgentHost.exe'
  Copy-Item -LiteralPath (Join-Path $package 'PharmFarm-AgentHost.exe') -Destination $hostPath
  $selfTest = Invoke-PharmFarmHiddenNative -FilePath $hostPath -Arguments @('-SelfTest')
  Assert-Host ($selfTest.ExitCode -eq 0) 'Windows GUI launcher and hidden PowerShell preflight succeed'
  [IO.File]::WriteAllText((Join-Path $testRoot 'PharmFarm-Agent.ps1'), 'param($ConfigPath); exit 23')
  $exitTest = Invoke-PharmFarmHiddenNative -FilePath $hostPath -Arguments @('-Role','agent')
  Assert-Host ($exitTest.ExitCode -eq 23) 'Child nonzero exit propagates to Scheduler host'

  $fixture = @'
param($ConfigPath)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'child.pid'), [string]$PID)
Start-Sleep -Seconds 60
'@
  [IO.File]::WriteAllText((Join-Path $testRoot 'PharmFarm-Agent.ps1'), $fixture)
  $launcher = Start-PharmFarmNativeProcess (New-PharmFarmHiddenProcessInfo -FilePath $hostPath -Arguments @('-Role','agent') -WorkingDirectory $testRoot)
  $owned.Add($launcher)
  $childFile = Join-Path $testRoot 'child.pid'
  Wait-TestFile $childFile
  $child = Get-Process -Id ([int][IO.File]::ReadAllText($childFile))
  [void]$child.Handle
  $owned.Add($child)
  Assert-Host ($launcher.MainWindowHandle -eq [IntPtr]::Zero -and $child.MainWindowHandle -eq [IntPtr]::Zero) 'Host and child have no main console window'
  $launcher.Kill()
  Assert-Host ($child.WaitForExit(5000)) 'Killing Scheduler host terminates its primary PowerShell child'
  Remove-Item -LiteralPath $childFile

  # A direct fallback launched inside watchdog must outlive watchdog's normal exit.
  $watchdogFixture = @'
param($InstallRoot)
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = Join-Path $PSScriptRoot 'PharmFarm-AgentHost.exe'
$info.Arguments = '-Role agent'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$process = [Diagnostics.Process]::Start($info)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'recovered-host.pid'), [string]$process.Id)
$process.Dispose()
exit 0
'@
  [IO.File]::WriteAllText((Join-Path $testRoot 'PharmFarm-AgentWatchdog.ps1'), $watchdogFixture)
  $watchdogResult = Invoke-PharmFarmHiddenNative -FilePath $hostPath -Arguments @('-Role','watchdog')
  $recovered = Get-Process -Id ([int][IO.File]::ReadAllText((Join-Path $testRoot 'recovered-host.pid')))
  [void]$recovered.Handle
  $owned.Add($recovered)
  Wait-TestFile $childFile
  $recoveredChild = Get-Process -Id ([int][IO.File]::ReadAllText($childFile))
  [void]$recoveredChild.Handle
  $owned.Add($recoveredChild)
  Assert-Host ($watchdogResult.ExitCode -eq 0 -and !$recovered.HasExited -and !$recoveredChild.HasExited) 'Recovered collector survives watchdog exit through independent Job lifetime'
  $recovered.Kill()
  Assert-Host ($recoveredChild.WaitForExit(5000)) 'Recovered host still owns cleanup of its child'
  Write-Host "Passed $checks Windows host integration assertions. Also visually observe several real watchdog cycles after approved installation."
} finally {
  foreach ($process in $owned) {
    try { if (!$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) } } finally { $process.Dispose() }
  }
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
