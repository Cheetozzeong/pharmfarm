param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$package = Join-Path $RepositoryRoot 'windows-agent-production'
. (Join-Path $package 'PharmFarm-AgentLifecycle.ps1')
. (Join-Path $package 'PharmFarm-AgentTasks.ps1')
$script:checks = 0
function Assert-Windowless([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
  $script:checks++
  Write-Host "PASS: $Message"
}
[string]$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-windowless-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
try {
  # PE subsystem and AnyCPU flags, no Windows execution needed.
  $binary = [IO.File]::ReadAllBytes((Join-Path $package 'PharmFarm-AgentHost.exe'))
  $pe = [BitConverter]::ToInt32($binary, 0x3c)
  Assert-Windowless ([BitConverter]::ToUInt32($binary, $pe) -eq 0x4550) 'Launcher is a valid PE executable'
  Assert-Windowless ([BitConverter]::ToUInt16($binary, $pe + 24 + 68) -eq 2) 'Launcher PE subsystem is Windows GUI, not console'
  $hostAssembly = [Reflection.Assembly]::Load($binary)
  $hostType = $hostAssembly.GetType('PharmFarmAgentHost', $true)
  $build = $hostType.GetMethod('BuildArguments', [Reflection.BindingFlags]'NonPublic,Static')
  $quote = $hostType.GetMethod('Quote', [Reflection.BindingFlags]'NonPublic,Static')
  $architecture = [Reflection.PortableExecutableKinds]::ILOnly; $machine = [Reflection.ImageFileMachine]::I386
  $hostAssembly.ManifestModule.GetPEKind([ref]$architecture, [ref]$machine)
  Assert-Windowless (($architecture -band [Reflection.PortableExecutableKinds]::Required32Bit) -eq 0) 'Launcher is not forced to 32-bit'
  foreach ($name in @('PharmFarm-Agent.ps1','PharmFarm-AgentTray.ps1','PharmFarm-AgentWatchdog.ps1')) {
    [IO.File]::WriteAllText((Join-Path $testRoot $name), '# fixture only')
  }
  foreach ($role in @('agent', 'tray', 'watchdog')) {
    $command = $build.Invoke($null, @([string[]]@('-Role', $role), $testRoot))
    Assert-Windowless ($command -match '-File "' -and $command.Contains($testRoot)) "$role is restricted to adjacent script and installation"
    $xmlText = New-PharmFarmTaskXml -Role $role -InstallRoot $testRoot -UserSid 'S-1-5-21-1-2-3-1001'
    [xml]$xml = $xmlText
    Assert-Windowless ([string]$xml.Task.Actions.Exec.Command -eq (Join-Path $testRoot 'PharmFarm-AgentHost.exe')) "$role task directly starts GUI host, never powershell/cmd"
    Assert-Windowless ([string]$xml.Task.Actions.Exec.Arguments -ceq "-Role $role") "$role task has only its expected role"
  }
  foreach ($value in @('', 'C:\path with spaces\', 'value"with quote', 'C:\한글 약국\')) {
    $managed = $quote.Invoke($null, @($value))
    Assert-Windowless ((ConvertTo-PharmFarmNativeArgument $value) -ceq $managed) 'Native argument quoting matches host for spaces/quotes/trailing slashes/Unicode'
  }
  foreach ($argsToReject in @(
    [string[]]@('-Role','unknown'), [string[]]@('-Role','tray','-Command','anything'),
    [string[]]@('-Role','agent','-ResyncTodayPrescriptions','-MaintenanceToken','bad'),
    [string[]]@('-Role','agent','-ConfigPath','foreign.json')
  )) {
    $rejected = $false
    try { $build.Invoke($null, @($argsToReject, $testRoot)) | Out-Null } catch { $rejected = $true }
    Assert-Windowless $rejected 'Host rejects unsupported role/command/config/token'
  }
  $resync = $build.Invoke($null, @([string[]]@('-Role','agent','-ResyncTodayPrescriptions','-MaintenanceToken',('a' * 32)), $testRoot))
  Assert-Windowless ($resync.Contains('-ResyncTodayPrescriptions') -and $resync.Contains(('a' * 32))) 'Explicit resync preserves its maintenance token'
  $resume = $build.Invoke($null, @([string[]]@('-Role','tray','-Resume'), $testRoot))
  Assert-Windowless ($resume.EndsWith(' -Resume')) 'Explicit tray resume remains supported'
  $selfTest = $build.Invoke($null, @([string[]]@('-SelfTest'), $testRoot))
  Assert-Windowless ($selfTest -match 'exit 0' -and $selfTest -notmatch 'Agent.ps1') 'Preflight starts no collector and reads no pharmacy data'

  $info = New-PharmFarmHiddenProcessInfo -FilePath 'C:\Windows\System32\schtasks.exe' -Arguments @('/End','/TN','PharmFarmAgent') -WorkingDirectory $testRoot
  Assert-Windowless (!$info.UseShellExecute -and $info.CreateNoWindow) 'Native support calls create no console and use no shell'
  Assert-Windowless ($info.Arguments -ceq '"/End" "/TN" "PharmFarmAgent"') 'Support arguments are quoted independently'
  if ($env:OS -ne 'Windows_NT') {
    $native = Invoke-PharmFarmHiddenNative -FilePath '/bin/sh' -Arguments @('-c','printf out; printf err >&2; exit 7')
    Assert-Windowless ($native.ExitCode -eq 7 -and $native.Output.Contains('out') -and $native.Output.Contains('err')) 'Real native process captures both streams and nonzero exit'
    $timedOut = $false
    try { Invoke-PharmFarmHiddenNative -FilePath '/bin/sleep' -Arguments @('5') -TimeoutSeconds 1 | Out-Null }
    catch { $timedOut = $_.Exception.Message -match 'timed out' }
    Assert-Windowless $timedOut 'Native support timeout is bounded and reported'
  }

  & {
    # A GUI host must be discoverable for stop, but cannot mask a dead collector.
    function Get-CimInstance {
      param($ClassName, $Filter, $ErrorAction)
      return @(
        [pscustomobject]@{ ProcessId=41001; Name='PharmFarm-AgentHost.exe'; ExecutablePath=(Join-Path $testRoot 'PharmFarm-AgentHost.exe'); CommandLine='"host.exe" -Role agent' },
        [pscustomobject]@{ ProcessId=41002; Name='PharmFarm-AgentHost.exe'; ExecutablePath='/foreign/PharmFarm-AgentHost.exe'; CommandLine='"host.exe" -Role agent' },
        [pscustomobject]@{ ProcessId=41003; Name='PharmFarm-AgentHost.exe'; ExecutablePath=(Join-Path $testRoot 'PharmFarm-AgentHost.exe'); CommandLine='"host.exe" -Role tray' },
        [pscustomobject]@{ ProcessId=41004; Name='PharmFarm-AgentHost.exe'; ExecutablePath=(Join-Path $testRoot 'PharmFarm-AgentHost.exe'); CommandLine='"host.exe"' }
      )
    }
    Assert-Windowless (@(Get-PharmFarmProcesses -InstallRoot $testRoot -Roles @('agent')).Count -eq 0) 'Host alone never counts as a live collector'
    $hosts = @(Get-PharmFarmProcesses -InstallRoot $testRoot -Roles @('agent') -IncludeLaunchers)
    Assert-Windowless ($hosts.Count -eq 1 -and $hosts[0].ProcessId -eq 41001) 'Stop includes only matching installation and host role'
    $trays = @(Get-PharmFarmProcesses -InstallRoot $testRoot -Roles @('tray') -IncludeLaunchers)
    Assert-Windowless ($trays.Count -eq 2 -and 41004 -in $trays.ProcessId) 'Repair also waits for a double-clicked tray host to release its executable'
  }

  # Fail preflight BEFORE maintenance or any task disable/copy.
  & {
    function Invoke-PharmFarmHiddenNative { param($FilePath, $Arguments) return [pscustomobject]@{ ExitCode=1; Output='blocked' } }
    $failed = $false
    try { Assert-PharmFarmPackage -SourceRoot $package -InstallRoot $testRoot } catch { $failed = $_.Exception.Message -match 'self-test failed' }
    Assert-Windowless $failed 'Launcher preflight failure is surfaced before modifying the installation'
    Assert-Windowless (!(Test-Path (Join-Path $testRoot 'lifecycle/maintenance.json'))) 'Failed preflight leaves no maintenance block'
  }
  Write-Host "Passed $script:checks windowless assertions. Native Windows Job/desktop behavior requires the Windows integration suite."
} finally { Remove-Item -LiteralPath $testRoot -Recurse -Force }
