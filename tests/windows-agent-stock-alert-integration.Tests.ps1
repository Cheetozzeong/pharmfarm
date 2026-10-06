param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
# Real WinForms, launched through the shipped native host. Isolated fake
# alerts only; no ProgramData, Scheduler, SQL, network, or patient data.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows is required for real alert visibility verification.' }
$package = Join-Path $RepositoryRoot 'windows-agent-production'
. (Join-Path $package 'PharmFarm-AgentLifecycle.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-alert-integration-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$process = $null
try {
  Copy-Item (Join-Path $package 'PharmFarm-AgentHost.exe') (Join-Path $root 'PharmFarm-AgentHost.exe')
  Copy-Item (Join-Path $package 'PharmFarm-AgentTray.ps1') (Join-Path $root 'tray-source.ps1')
  Copy-Item (Join-Path $package 'PharmFarm-AgentLifecycle.ps1') (Join-Path $root 'PharmFarm-AgentLifecycle.ps1')
  $fixture = @'
param($InstallRoot)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PharmFarmTrayWindow {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
"@
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $InstallRoot 'tray-source.ps1'),[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw ($errors.Message -join '; ') }
  $names=@('Ensure-Directory','Get-AlertValue','Get-AlertQuantityText','Get-AlertDisplayText',
    'Add-AlertGridColumn','Show-PrescriptionStockAlert','Check-PrescriptionStockAlerts','Complete-StockAlertDisplay','Write-TrayLog')
  foreach ($definition in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
    if ($definition.Name -in $names) { Invoke-Expression $definition.Extent.Text }
  }
  . (Join-Path $InstallRoot 'PharmFarm-AgentLifecycle.ps1')
  $LogDir=Join-Path $InstallRoot 'logs'
  $UiAlertDir=Join-Path $InstallRoot 'ui-alerts'
  $UiAlertShownDir=Join-Path $InstallRoot 'ui-alerts-shown'
  $UiAlertFailedDir=Join-Path $InstallRoot 'ui-alerts-failed'
  foreach ($dir in @($LogDir,$UiAlertDir,$UiAlertShownDir,$UiAlertFailedDir)) { Ensure-Directory $dir }
  function Show-Balloon { param($Title,$Text,$Icon) }
  function Assert-Fixture([bool]$value,[string]$message) { if (!$value) { throw $message }; Add-Content (Join-Path $InstallRoot 'passes.txt') $message }
  function New-Alert([string]$name,[bool]$old) {
    $path=Join-Path $UiAlertDir ($name+'.json')
    [IO.File]::WriteAllText($path,'{"prescriptionCodes":["TEST-NO-PATIENT"],"rows":[{"lineNo":1,"drugName":"TEST DRUG","alertType":"SHORTAGE","requestedQuantity":3,"stockBeforeQuantity":1,"stockAfterQuantity":-2,"shortageQuantity":2}]}')
    if ($old) { [IO.File]::SetLastWriteTime($path,(Get-Date).AddDays(-2)) }
  }
  Assert-Fixture ([Threading.Thread]::CurrentThread.ApartmentState -eq 'STA') 'Tray child is STA'
  Assert-Fixture ([PharmFarmTrayWindow]::GetConsoleWindow() -eq [IntPtr]::Zero) 'No console window exists'
  New-Alert old1 $true; New-Alert old2 $true
  $script:showingStockAlert=$false; $script:closingTray=$false
  Check-PrescriptionStockAlerts
  Assert-Fixture ($script:stockAlertDisplayed -and [PharmFarmTrayWindow]::IsWindowVisible($script:stockAlertForm.Handle)) 'First alert really is visible through the windowless host'
  Assert-Fixture ($script:stockAlertFiles.Count -eq 2 -and $script:stockAlertForm.Controls[1].Text -ne '') 'Historical backlog is grouped into one visible form'
  Assert-Fixture (@(Get-ChildItem $UiAlertDir -Filter '*.json').Count -eq 2) 'Visible but unacknowledged alerts remain pending'
  $script:ticks=0
  $script:timer=New-Object Windows.Forms.Timer
  $script:timer.Interval=500
  $script:timer.Add_Tick({
    try {
      $script:ticks++
      Write-PharmFarmProgress -InstallRoot $InstallRoot -Role tray -Phase alerts
      if ($script:ticks -eq 2) {
        Assert-Fixture (Test-Path (Join-Path $InstallRoot 'lifecycle/tray.progress')) 'UI timer heartbeat continues while the alert is open'
        New-Alert fresh $false
        Check-PrescriptionStockAlerts
        Assert-Fixture ($script:stockAlertFiles.Count -eq 2) 'Open popup prevents duplicate popup creation'
        $script:stockAlertForm.Close()
        Assert-Fixture (@(Get-ChildItem $UiAlertShownDir -Filter '*.json').Count -eq 2) 'Acknowledgment preserves historical files in shown archive'
        Check-PrescriptionStockAlerts
        Assert-Fixture ($script:stockAlertFiles.Count -eq 1 -and $script:stockAlertDisplayed) 'Fresh alert is displayed after historical summary closes'
        $script:closingTray=$true
        $script:stockAlertForm.Close()
        Assert-Fixture (Test-Path (Join-Path $UiAlertDir 'fresh.json')) 'Update/shutdown does not acknowledge unread alerts'
        $script:closingTray=$false
        [IO.File]::WriteAllText((Join-Path $UiAlertDir 'bad.json'),'not-json')
        Remove-Item (Join-Path $UiAlertDir 'fresh.json')
        Check-PrescriptionStockAlerts
        Assert-Fixture (Test-Path (Join-Path $UiAlertFailedDir 'bad.json')) 'Malformed alerts are quarantined rather than blocking the queue'
        [IO.File]::WriteAllText((Join-Path $InstallRoot 'success.txt'),'ok')
        $script:timer.Stop()
        [Windows.Forms.Application]::ExitThread()
      }
    } catch {
      [IO.File]::WriteAllText((Join-Path $InstallRoot 'error.txt'),($_ | Out-String))
      $script:timer.Stop(); [Windows.Forms.Application]::ExitThread()
    }
  })
  $script:timer.Start()
  [Windows.Forms.Application]::Run()
  $script:timer.Dispose()
} catch {
  [IO.File]::WriteAllText((Join-Path $InstallRoot 'error.txt'),($_ | Out-String))
  exit 1
}
'@
  [IO.File]::WriteAllText((Join-Path $root 'PharmFarm-AgentTray.ps1'),$fixture)
  $process = Start-PharmFarmNativeProcess (New-PharmFarmHiddenProcessInfo -FilePath (Join-Path $root 'PharmFarm-AgentHost.exe') -Arguments @('-Role','tray') -WorkingDirectory $root)
  if (!$process.WaitForExit(30000)) { throw 'Real alert fixture timed out: hidden/modal popup or stalled timer.' }
  $errorPath=Join-Path $root 'error.txt'
  if (Test-Path $errorPath) { throw [IO.File]::ReadAllText($errorPath) }
  if ($process.ExitCode -ne 0 -or !(Test-Path (Join-Path $root 'success.txt'))) { throw 'Alert fixture did not complete.' }
  Get-Content (Join-Path $root 'passes.txt') | ForEach-Object { Write-Host "PASS: $_" }
} finally {
  if ($null -ne $process) { if (!$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }; $process.Dispose() }
  [IO.Directory]::Delete($root,$true)
}
