param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
# Only extract the heartbeat function. No agent startup, SQL, files or network.
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-Agent.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors.Message -join '; ') }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Submit-AgentHeartbeat' }, $true)
Invoke-Expression $function.Extent.Text
$script:calls = 0; $script:response = 404; $script:HeartbeatUnavailableUntil = $null
function Read-JsonFile { return @{} }
function Convert-NullableInt { param($Value) return $Value }
function Get-Sha256Hex { return 'fixture' }
function Get-QueueFiles { return @() }
function Get-AgentObjectValue { param($Object, $Name, $DefaultValue) return $DefaultValue }
function Get-AgentTimestamp { return 'fixture-time' }
function New-RequestHeaders { param($Config, $BodyText) return @{} }
function Join-AgentApiUrl { param($Config, $Path) return ('https://fixture.invalid' + $Path) }
function Invoke-RestMethod {
  param($Method, $Uri, $ContentType, $Headers, $Body, $TimeoutSec)
  $script:calls++
  if ($script:response -ne 200) { throw 'fixture HTTP failure' }
}
function Get-AgentHttpStatusCodeFromError { return $script:response }
function Write-AgentLog { }
function Convert-LogText { param($Value) return $Value }
function Assert-Test([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
  Write-Host "PASS: $Message"
}
$config = [pscustomobject]@{ pharmacyId = 1; deviceId = 'fixture'; deviceName = 'fixture' }
$result = Submit-AgentHeartbeat -Config $config
Assert-Test (!$result.submitted -and $script:calls -eq 1 -and $script:HeartbeatUnavailableUntil -gt [DateTime]::UtcNow.AddMinutes(4)) '404 sets a temporary cooldown, not permanent disable'
$result = Submit-AgentHeartbeat -Config $config
Assert-Test ($result.skipped -eq 'endpoint-unavailable' -and $script:calls -eq 1) 'Cooldown avoids repeated unsupported requests'
$script:HeartbeatUnavailableUntil = [DateTime]::UtcNow.AddSeconds(-1)
$script:response = 200
$result = Submit-AgentHeartbeat -Config $config
Assert-Test ($result.submitted -and $script:calls -eq 2 -and $null -eq $script:HeartbeatUnavailableUntil) 'Heartbeat automatically resumes after endpoint recovers'
$script:HeartbeatUnavailableUntil = [DateTime]::UtcNow.AddMinutes(5)
$result = Submit-AgentHeartbeat -Config $config -Force
Assert-Test ($result.submitted -and $script:calls -eq 3) 'Explicit force can bypass temporary cooldown'
$script:response = 503
$result = Submit-AgentHeartbeat -Config $config
Assert-Test (!$result.submitted -and $null -eq $script:HeartbeatUnavailableUntil) 'Transient failure never permanently disables heartbeat'
Write-Host 'Passed 5 heartbeat recovery assertions.'
