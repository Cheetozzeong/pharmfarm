param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-Agent.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors.Message -join '; ')}
$names=@('Submit-Envelope','Get-AgentHttpStatusCodeFromError','Get-AgentHttpResponseFromError','Get-ResponseBodyFromException','Convert-LogText')
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  if($fn.Name -in $names){Invoke-Expression $fn.Extent.Text}
}
Add-Type @'
using System;
using System.Net;
using System.IO;
using System.Text;
public class FixtureWebResponse : WebResponse {
  public int StatusCode { get; set; }
  public override Stream GetResponseStream() { return new MemoryStream(Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"fixture conflict\"}")); }
}
'@
function Write-AgentLog {param($Message,$Level)}
function New-RequestHeaders {param($Config,$BodyText)return @{}}
function Save-PrescriptionStockAlert {param($Envelope,$Response)return 0}
function Invoke-AgentJsonPostUtf8 {
  param($Uri,$Headers,$Body,$TimeoutSeconds)
  $response=New-Object FixtureWebResponse
  $response.StatusCode=[int]$script:fixtureStatus
  $inner=New-Object Net.WebException('fixture failure',$null,[Net.WebExceptionStatus]::ProtocolError,$response)
  throw (New-Object Management.Automation.MethodInvocationException('wrapped GetResponse failure',$inner))
}
$checks=0
foreach($case in @(@(400,$false),@(409,$false),@(422,$false),@(408,$true),@(429,$true),@(503,$true))) {
  $script:fixtureStatus=$case[0]
  $result=Submit-Envelope ([pscustomobject]@{apiBase='https://fixture.invalid';pharmacyId=1}) ([pscustomobject]@{targetPath='/fixture';eventId='fixture';payload=@{items=@()}})
  if($result.status -ne $case[0] -or $result.retry -ne $case[1] -or $result.ok){throw "Incorrect handling for $($case[0]): $($result | ConvertTo-Json -Compress)"}
  if(!$case[1] -and $result.message -notmatch 'fixture conflict'){throw 'Business rejection reason lost'}
  $checks++;Write-Host "PASS: Wrapped HTTP $($case[0]) classified; retry=$($result.retry)"
}
Write-Host "Passed $checks wrapped HTTP error assertions."
