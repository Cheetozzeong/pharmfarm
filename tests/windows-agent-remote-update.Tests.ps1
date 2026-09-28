param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'

$agentPath = Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-Agent.ps1'
$updaterPath = Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-AgentUpdate.ps1'
foreach ($path in @($agentPath, $updaterPath)) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "PowerShell syntax error in $path`: $($errors.Message -join '; ')" }
}

$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($agentPath, [ref]$tokens, [ref]$errors)
foreach ($name in @('Invoke-AgentUpdateCommand', 'Start-AgentDetachedUpdate', 'Submit-PendingAgentUpdateResult')) {
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if ($null -eq $definition) { throw "Missing $name" }
  Invoke-Expression $definition.Extent.Text
}

function Assert-RemoteUpdate([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
  Write-Host "PASS: $Message"
}
function Get-AgentObjectValue { param($Object, $Name, $DefaultValue) if ($null -eq $Object) { return $DefaultValue }; return $Object.$Name }
function Convert-AgentText { param($Value) return [string]$Value }
function Write-AgentLog { }
$script:AgentVersion = '1.4.5-ps'
$script:InstallRoot = Join-Path ([IO.Path]::GetTempPath()) ('PharmFarm-update-fixture-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $script:InstallRoot)
$commandId = [Guid]::NewGuid().ToString()
$hash = 'a' * 64
$downloadCalls = 0
$launchCalls = 0

if ($env:OS -eq 'Windows_NT') {
  $launchFixture = Join-Path $script:InstallRoot 'launcher-fixture'
  [void](New-Item -ItemType Directory -Path $launchFixture)
  $marker = Join-Path $launchFixture 'launched.txt'
  $scriptText = 'param($CommandId,$ExpectedVersion,$InstallRoot) [IO.File]::WriteAllText((Join-Path $PSScriptRoot "launched.txt"), "$CommandId|$ExpectedVersion")'
  [IO.File]::WriteAllText((Join-Path $launchFixture 'PharmFarm-AgentUpdate.ps1'), $scriptText)
  $childPid = Start-AgentDetachedUpdate -SourceRoot $launchFixture -CommandId $commandId -ExpectedVersion '1.4.6-ps'
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (!(Test-Path -LiteralPath $marker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  Assert-RemoteUpdate ($childPid -gt 0 -and (Test-Path -LiteralPath $marker) -and
    [IO.File]::ReadAllText($marker) -eq "$commandId|1.4.6-ps") 'Detached hidden updater launches a restricted adjacent script'
}

function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec, $ErrorAction) $script:downloadCalls++; [IO.File]::WriteAllText($OutFile, 'fixture zip') }
function Get-FileHash { param($LiteralPath, $Algorithm, $ErrorAction) return [pscustomobject]@{ Hash = $script:downloadHash } }
function Expand-Archive {
  param($LiteralPath, $DestinationPath, $ErrorAction)
  $source = Join-Path $DestinationPath 'windows-agent-production'
  [void](New-Item -ItemType Directory -Path $source -Force)
  [IO.File]::WriteAllText((Join-Path $source 'PharmFarm-Agent.ps1'), '$AgentVersion = "1.4.6-ps"')
  [IO.File]::WriteAllText((Join-Path $source 'PharmFarm-AgentUpdate.ps1'), '# fixture')
}
function Start-AgentDetachedUpdate { param($SourceRoot, $CommandId, $ExpectedVersion) $script:launchCalls++; return 4242 }

try {
  $invalid = $false
  try { Invoke-AgentUpdateCommand -Command ([pscustomobject]@{ payload = [pscustomobject]@{ version = '1.4.6-ps'; sha256 = 'bad' } }) -CommandId $commandId | Out-Null }
  catch { $invalid = $_.Exception.Message -match 'invalid version' }
  Assert-RemoteUpdate ($invalid -and $downloadCalls -eq 0) 'Invalid digest is rejected before download'

  $same = Invoke-AgentUpdateCommand -Command ([pscustomobject]@{ payload = [pscustomobject]@{ version = '1.4.5-ps'; sha256 = $hash } }) -CommandId $commandId
  Assert-RemoteUpdate ($same.status -eq 'COMPLETED' -and $downloadCalls -eq 0) 'Already-installed version is not reinstalled'

  $script:downloadHash = 'b' * 64
  $mismatch = $false
  try { Invoke-AgentUpdateCommand -Command ([pscustomobject]@{ payload = [pscustomobject]@{ version = '1.4.6-ps'; sha256 = $hash } }) -CommandId $commandId | Out-Null }
  catch { $mismatch = $_.Exception.Message -match 'SHA-256' }
  Assert-RemoteUpdate ($mismatch -and $launchCalls -eq 0 -and !(Test-Path (Join-Path ([IO.Path]::GetTempPath()) ('PharmFarmRemoteUpdate-' + $commandId)))) 'Hash mismatch leaves installation untouched and removes staging'

  $script:downloadHash = $hash
  $started = Invoke-AgentUpdateCommand -Command ([pscustomobject]@{ payload = [pscustomobject]@{ version = '1.4.6-ps'; sha256 = $hash } }) -CommandId $commandId
  Assert-RemoteUpdate ($started.status -eq 'STARTED' -and $launchCalls -eq 1) 'Verified package starts detached updater once'
} finally {
  $staged = Join-Path ([IO.Path]::GetTempPath()) ('PharmFarmRemoteUpdate-' + $commandId)
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Recurse -Force }
  Remove-Item -LiteralPath $script:InstallRoot -Recurse -Force
}
