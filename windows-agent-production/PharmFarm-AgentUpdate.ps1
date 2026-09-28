param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$CommandId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+-ps$')][string]$ExpectedVersion,
  [string]$InstallRoot = (Join-Path $env:ProgramData 'PharmFarmAgent')
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$sourceRoot = $PSScriptRoot
$logRoot = Join-Path $InstallRoot 'logs'
$resultPath = Join-Path $InstallRoot 'agent.update-result.json'
$exitCode = 1

function Write-UpdateLog([string]$Message) {
  try {
    [void](New-Item -ItemType Directory -Path $logRoot -Force)
    Add-Content -LiteralPath (Join-Path $logRoot ('update-' + (Get-Date -Format 'yyyyMMdd') + '.log')) -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message)
  } catch { }
}

function Write-UpdateResult([string]$Status, [string]$Message, $Details) {
  $value = [ordered]@{
    commandId = $CommandId
    commandType = 'UPDATE_AGENT'
    status = $Status
    message = $Message
    result = $Details
    updatedAt = [DateTimeOffset]::Now.ToString('o')
  }
  $temporaryPath = $resultPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $value | ConvertTo-Json -Depth 12 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $temporaryPath -Destination $resultPath -Force -ErrorAction Stop
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
  }
  return $value
}

function Submit-UpdateResult($Value) {
  $configPath = Join-Path $InstallRoot 'agent.config.json'
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $apiBase = [string]$config.apiBase
  if ([string]::IsNullOrWhiteSpace($apiBase) -or [string]::IsNullOrWhiteSpace([string]$config.deviceId)) {
    throw 'Agent API identity is missing.'
  }
  $installedScript = Join-Path $InstallRoot 'PharmFarm-Agent.ps1'
  $versionMatch = [regex]::Match([IO.File]::ReadAllText($installedScript), '\$AgentVersion\s*=\s*"([^"]+)"')
  $agentVersion = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { '' }
  $payload = [ordered]@{
    pharmacyId = $config.pharmacyId
    deviceId = $config.deviceId
    deviceName = $config.deviceName
    agentVersion = $agentVersion
    commandId = $CommandId
    commandType = 'UPDATE_AGENT'
    status = $Value.status
    message = $Value.message
    result = $Value.result
    updatedAt = $Value.updatedAt
  }
  $json = $payload | ConvertTo-Json -Depth 16 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $headers = @{
    'X-PharmFarm-Agent-Version' = $agentVersion
    'X-PharmFarm-Device-Id' = [string]$config.deviceId
    'X-PharmFarm-Pharmacy-Id' = [string]$config.pharmacyId
  }
  if (![string]::IsNullOrWhiteSpace([string]$config.agentSecret)) {
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $nonce = [Guid]::NewGuid().ToString('N')
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bodyHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $secret = [Text.Encoding]::UTF8.GetBytes([string]$config.agentSecret)
    $hmac = New-Object Security.Cryptography.HMACSHA256 -ArgumentList (, $secret)
    try { $signature = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$timestamp.$nonce.$bodyHash")))).Replace('-', '').ToLowerInvariant() }
    finally { $hmac.Dispose() }
    $headers['X-PharmFarm-Timestamp'] = $timestamp
    $headers['X-PharmFarm-Nonce'] = $nonce
    $headers['X-PharmFarm-Signature'] = $signature
  }
  $url = $apiBase.TrimEnd('/') + '/agent/commands/' + [Uri]::EscapeDataString($CommandId) + '/result'
  [void](Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 15)
}

try {
  Write-UpdateLog "remote update started commandId=$CommandId target=$ExpectedVersion"
  $repairScript = Join-Path $sourceRoot 'PharmFarm-AgentRepair.ps1'
  if (!(Test-Path -LiteralPath $repairScript -PathType Leaf)) { throw 'Verified repair script is missing.' }
  $report = & $repairScript -InstallRoot $InstallRoot -SourceRoot $sourceRoot -ReturnReport
  if (!$report.settingsVerified -or !$report.configPreserved -or !$report.runtimeStartRequested) {
    throw 'Repair did not verify the protected restart.'
  }
  $installedScript = Join-Path $InstallRoot 'PharmFarm-Agent.ps1'
  $installedText = [IO.File]::ReadAllText($installedScript)
  if ($installedText -notmatch ('\$AgentVersion\s*=\s*"' + [regex]::Escape($ExpectedVersion) + '"')) {
    throw 'Installed agent version did not match the requested release.'
  }
  $value = Write-UpdateResult -Status 'COMPLETED' -Message "Agent $ExpectedVersion installed; CMS connection verification pending." -Details ([ordered]@{
    targetVersion = $ExpectedVersion
    backupPath = $report.backupPath
    configPreserved = $true
    runtimeStartRequested = $true
  })
  Write-UpdateLog "remote update installed commandId=$CommandId version=$ExpectedVersion"
  $exitCode = 0
} catch {
  $message = [string]$_.Exception.Message
  if ($message.Length -gt 700) { $message = $message.Substring(0, 700) }
  Write-UpdateLog "remote update failed commandId=$CommandId error=$message"
  try { $value = Write-UpdateResult -Status 'FAILED' -Message $message -Details ([ordered]@{ targetVersion = $ExpectedVersion }) }
  catch { Write-UpdateLog "could not save update result: $($_.Exception.Message)" }
}

if ($null -ne $value) {
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Submit-UpdateResult -Value $value
      Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
      Write-UpdateLog "remote update result sent commandId=$CommandId status=$($value.status)"
      break
    } catch {
      Write-UpdateLog "remote update result retry=$attempt failed: $($_.Exception.Message)"
      if ($attempt -lt 5) { Start-Sleep -Seconds 10 }
    }
  }
}

exit $exitCode
