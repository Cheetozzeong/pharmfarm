param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
# Execute only queue helpers with isolated files and a mocked HTTP result.
$ErrorActionPreference = 'Stop'
$agentPath = Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-Agent.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($agentPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors.Message -join '; ') }
$selected = @('Set-AgentObjectProperty', 'New-BootstrapEnvelope', 'New-AgentEnvelope', 'New-Payload', 'Flush-Queue')
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($definition.Name -in $selected) { Invoke-Expression $definition.Extent.Text }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('pharmfarm-queue-tests-' + [guid]::NewGuid().ToString('N'))
$script:QueueDir = Join-Path $root 'queue'
$script:SentDir = Join-Path $root 'sent'
$script:DeadDir = Join-Path $root 'dead-letter'
$script:InstallRoot = $root
$script:AgentVersion = 'fixture'
$script:submitCalls = 0
$script:checks = 0
function Assert-Test([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
  $script:checks++
  Write-Host "PASS: $Message"
}
function Ensure-Directory([string]$Path) { [void][IO.Directory]::CreateDirectory($Path) }
function Write-PharmFarmProgress { param($InstallRoot, $Phase) }
function Write-AgentLog { param($Message, $Level) }
function Get-AgentTimestamp { return [DateTimeOffset]::Now.ToString('o') }
function Get-Sha256Hex([string]$Text) { return ('a' * 64) }
function Convert-NullableInt($Value) { return $Value }
function Convert-NullableDouble($Value) { return $Value }
function Convert-AgentLocalDateTimeOffset($Value) { return '2026-09-21T10:00:00+09:00' }
function Get-RetryDelaySeconds([int]$Attempts) { return 60 }
function Get-QueueFiles { Ensure-Directory $script:QueueDir; return @(Get-ChildItem $script:QueueDir -Filter '*.json' -File | Sort-Object LastWriteTime) }
function Read-JsonFile([string]$Path) { return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-JsonFile([string]$Path, [object]$Value, [int]$Depth = 20) {
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth $Depth), $encoding)
}
function Submit-Envelope {
  param($Config, $Envelope)
  $script:submitCalls++
  if ($script:submitCalls -eq 1) { return @{ ok = $false; retry = $true; status = $null; message = 'fixture timeout' } }
  return @{ ok = $true; retry = $false; status = 200; message = 'sent' }
}

try {
  Ensure-Directory $QueueDir
  # Model a queue file written by every released version before 1.4.3.
  $legacyPath = Join-Path $QueueDir 'legacy.json'
  Write-JsonFile $legacyPath ([ordered]@{
    eventId = 'legacy'; createdAt = Get-AgentTimestamp; targetPath = '/agent/prescriptions'
    attempts = 0; nextAttemptAt = '2000-01-01T00:00:00Z'; payload = [ordered]@{ items = @() }
  }) 10

  Flush-Queue ([pscustomobject]@{})
  $retry = Read-JsonFile $legacyPath
  Assert-Test ($retry.attempts -eq 1) 'Legacy queue retry increments attempts'
  Assert-Test ($retry.lastError -eq 'fixture timeout') 'Legacy queue gains lastError without property-assignment failure'
  Assert-Test ([DateTimeOffset]::Parse($retry.nextAttemptAt) -gt [DateTimeOffset]::Now) 'Legacy queue receives a future retry time'

  Set-AgentObjectProperty $retry 'nextAttemptAt' '2000-01-01T00:00:00Z'
  Write-JsonFile $legacyPath $retry 10
  Flush-Queue ([pscustomobject]@{})
  Assert-Test (!(Test-Path $legacyPath) -and (Test-Path (Join-Path $SentDir 'legacy.json'))) 'Legacy queue sends successfully after recovery'

  $config = [pscustomobject]@{ pharmacyId = 1; deviceId = 'fixture'; deviceName = 'fixture'; includeRawQrText = $false }
  $bootstrap = New-BootstrapEnvelope $config 'fixture' ([ordered]@{})
  $reference = New-AgentEnvelope $config 'fixture' '/agent/fixture' @()
  $prescription = New-Payload $config ([pscustomobject]@{ ps_Code = 'P1'; ps_Date = '20260921'; ps_edbBarcode = '' }) @()
  Assert-Test ($bootstrap.Contains('lastError') -and $bootstrap.lastError -eq '') 'New bootstrap queue declares lastError'
  Assert-Test ($reference.Contains('lastError') -and $reference.lastError -eq '') 'New reference queue declares lastError'
  Assert-Test ($prescription.Contains('lastError') -and $prescription.lastError -eq '') 'New prescription queue declares lastError'
  Write-Host "Passed $checks queue compatibility assertions."
} finally {
  if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}
