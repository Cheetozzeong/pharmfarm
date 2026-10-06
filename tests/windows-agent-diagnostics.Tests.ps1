param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$package = Join-Path $RepositoryRoot 'windows-agent-production'
. (Join-Path $package 'PharmFarm-AgentLifecycle.ps1')
. (Join-Path $package 'PharmFarm-AgentDiagnostics.ps1')
. (Join-Path $package 'PharmFarm-AgentTasks.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-diagnostics-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory((Join-Path $root 'logs'))
$checks = 0
function Assert-Diagnostic([bool]$condition, [string]$message) {
  if (!$condition) { throw $message }; $script:checks++; Write-Host "PASS: $message"
}
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $RepositoryRoot 'public/pharmfarm-agent-production.zip'))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($name in @(Get-PharmFarmPackageFileNames)) {
      $entry = $archive.GetEntry('windows-agent-production/' + $name)
      Assert-Diagnostic ($null -ne $entry) "Release includes required runtime $name"
      $stream = $entry.Open()
      try { $packed = [BitConverter]::ToString($sha.ComputeHash($stream)) } finally { $stream.Dispose() }
      $source = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $package $name))))
      Assert-Diagnostic ($packed -eq $source) "Release matches tested runtime $name"
    }
  } finally { $sha.Dispose(); $archive.Dispose() }
  $now = [DateTimeOffset]::Now.ToString('o')
  $day = Get-Date -Format yyyyMMdd
  $patient = 'PRIVATE-PATIENT-991231'; $secret = 'PRIVATE-SECRET-TOKEN'
  $lines = @(
    "$now alert visible files=63 rows=4 patientName=$patient secret=$secret",
    "$now alert display failed: lastError $patient $secret C:\private\config.json",
    "$now supervisor stale role=tray pid=1234 password=$secret",
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ERROR] unknown error $patient $secret",
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [INFO] patientName=$patient secret=$secret",
    "$([DateTimeOffset]::Now.AddDays(-3).ToString('o')) alert visible files=9 rows=9"
  )
  [IO.File]::WriteAllLines((Join-Path $root "logs/tray-$day.log"),$lines)
  # Forbidden files/data are deliberately present; no content may be read/uploaded.
  [IO.File]::WriteAllText((Join-Path $root 'agent.config.json'),$secret)
  [IO.File]::WriteAllText((Join-Path $root 'logs/patient-data.log'),$patient)
  [void][IO.Directory]::CreateDirectory((Join-Path $root 'ui-alerts'))
  [IO.File]::WriteAllText((Join-Path $root 'ui-alerts/one.json'),$patient)
  Write-PharmFarmProgress -InstallRoot $root -Role tray -Phase alerts
  $lease = Enter-PharmFarmLock -InstallRoot $root -Name tray
  try { $report = Get-PharmFarmDiagnostics -InstallRoot $root -AgentVersion '1.4.8-ps' }
  finally { $lease.Dispose() }
  $json = $report | ConvertTo-Json -Depth 12 -Compress
  Assert-Diagnostic ($json -notmatch 'PRIVATE|991231|private|agentSecret|password|patientName') 'Raw clinical/config/credential/path text never leaves the PC'
  Assert-Diagnostic ($report.files.Count -eq 1 -and $report.files[0].name -eq "tray-$day.log") 'Only the fixed diagnostic log filenames are read'
  Assert-Diagnostic ($report.files[0].entries.Count -eq 4) 'Old and unknown informational log lines are excluded'
  Assert-Diagnostic ($report.files[0].entries[0].metrics.files -eq 63) 'Useful safe alert counts are retained'
  Assert-Diagnostic ($report.files[0].entries[1].issue -eq 'PROPERTY_MISSING') 'Failure classification survives without raw exception text'
  Assert-Diagnostic ($report.counts['ui-alerts'] -eq 1) 'Alert metadata counts are collected without reading prescription files'
  $tray = @($report.runtime | Where-Object { $_.role -eq 'tray' })[0]
  Assert-Diagnostic ($tray.running -and $null -ne $tray.progressAgeSeconds) 'Running tray and UI progress age are diagnosed independently'
  Assert-Diagnostic ((Get-PharmFarmDiagnostics -InstallRoot $root -AgentVersion '1.4.8-ps' -Hours 999).hours -eq 48) 'Agent caps requested window to 48 hours'
  Assert-Diagnostic ((Get-PharmFarmDiagnostics -InstallRoot $root -AgentVersion '1.4.8-ps' -Hours -1).hours -eq 1) 'Agent rejects a negative duration by clamping to safe minimum'
  Assert-Diagnostic ($null -eq (Convert-PharmFarmDiagnosticEntry ('x' * 5000))) 'Oversized raw lines are not parsed'
  Assert-Diagnostic ((Convert-PharmFarmDiagnosticEntry "$now supervisor role=tray state=retry-limited").state -eq 'retry-limited') 'Fixed supervisor recovery states are retained'
  Assert-Diagnostic ((Convert-PharmFarmDiagnosticEntry "$now supervisor role=tray state=$secret").state -eq 'unknown') 'Unexpected supervisor state text cannot bypass privacy filtering'
  for ($i=0; $i -lt 16; $i++) {
    $date=(Get-Date).AddDays(-$i).ToString('yyyyMMdd')
    [IO.File]::WriteAllLines((Join-Path $root "logs/agent-$date.log"),@(("$now watch scan rows=1 tracked=2 $secret`n" * 2000)))
  }
  $report = Get-PharmFarmDiagnostics -InstallRoot $root -AgentVersion '1.4.8-ps'
  $json = $report | ConvertTo-Json -Depth 12 -Compress
  Assert-Diagnostic ($report.files.Count -le 16) 'At most 16 file tails are collected'
  Assert-Diagnostic (@($report.files | ForEach-Object { $_.entries }).Count -le 500) 'At most 500 events are uploaded'
  Assert-Diagnostic ([Text.Encoding]::UTF8.GetByteCount($json) -le 131072) 'Actual outbound JSON is limited to 128 KiB'
  Assert-Diagnostic ($json -notmatch 'PRIVATE') 'Large diagnostic tails remain privacy-filtered'
  $before=@(Get-ChildItem $root -Recurse -File).Count
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $package 'PharmFarm-Agent.ps1'),[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw ($errors.Message -join '; ') }
  foreach ($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
    if ($fn.Name -in @('Invoke-AgentCommandAction','Get-AgentObjectValue')) { Invoke-Expression $fn.Extent.Text }
  }
  $InstallRoot=$root; $AgentVersion='1.4.8-ps'
  $result=Invoke-AgentCommandAction -Config ([pscustomobject]@{}) -Command ([pscustomobject]@{payload=[pscustomobject]@{hours=24;path='C:\private'}}) -CommandId 'fixture' -CommandType 'COLLECT_DIAGNOSTICS'
  Assert-Diagnostic ($result.status -eq 'COMPLETED' -and $result.result.privacy -eq 'STRUCTURED_ALLOWLIST') 'CMS command collects structured diagnostics through the real action router'
  Assert-Diagnostic ($before -eq @(Get-ChildItem $root -Recurse -File).Count) 'Collection does not mutate files or create an extra resident process'
  Write-Host "Passed $checks diagnostic assertions."
} finally { [IO.Directory]::Delete($root,$true) }
