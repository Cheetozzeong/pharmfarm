param([string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$agentPath = Join-Path $RepositoryRoot 'windows-agent-production/PharmFarm-Agent.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($agentPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors.Message -join '; ') }
foreach ($fn in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  Invoke-Expression $fn.Extent.Text
}
$checks = 0
function Assert-Range([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }; $script:checks++; Write-Host "PASS: $Message"
}
foreach ($case in @(
  @('2026-10-28T03:00:00Z', '2026-10-26', '2026-11-01'),
  @('2026-11-01T14:59:59Z', '2026-10-26', '2026-11-01'),
  @('2026-11-01T15:00:00Z', '2026-11-02', '2026-11-08'),
  @('2027-01-01T03:00:00Z', '2026-12-28', '2027-01-03')
)) {
  $range = Get-PrescriptionWeekRange -Now ([DateTimeOffset]::Parse($case[0]))
  Assert-Range ($range.startDate -eq $case[1] -and $range.endDate -eq $case[2]) "Monday-Sunday Korea range at $($case[0])"
}
foreach ($case in @(
  @('', '2026-10-28'), @('2026-02-29', '2026-03-01'), @('2026-10-28', '2026-10-27'),
  @('2026-10-01', '2026-11-01'), @("2026-10-27' OR 1=1", '2026-10-28'), @('1899-12-31', '1900-01-01'), @('9999-01-01', '9999-01-01')
)) {
  $rejected = $false
  try { Get-PrescriptionDateRange -StartDate $case[0] -EndDate $case[1] | Out-Null } catch { $rejected = $true }
  Assert-Range $rejected "Reject invalid/oversized dates $($case[0]) / $($case[1])"
}
Assert-Range ((Get-PrescriptionDateRange '2026-10-01' '2026-10-31').endDate -eq '2026-10-31') '31 inclusive days accepted'
Assert-Range ((Get-PrescriptionDateRange '2028-02-29' '2028-02-29').startDate -eq '2028-02-29') 'Leap day accepted'

# All database/HTTP/filesystem boundaries are mocked; run the real scan, hash,
# envelope and remote command functions against yesterday's corrected prescription.
$script:sqlCalls = 0
$script:query = ''
$script:qr = [pscustomobject]@{ ps_Code = '202610270006'; ps_Date = '20261027'; ps_edbBarcode = ''; ps_CnvDef = ''; ps_Mcode = ''; ps_Mcodetype = '' }
$script:drug = [pscustomobject]@{ pd_no = 1; pd_iscode = '640007761'; drug_name = 'fixture drug'; pd_dose = 4; pd_dnum = 2; pd_dday = 60; pd_amount = 480; pd_extype = 0; pd_exrow = 0; pd_element = '' }
$script:hashes = @{}
$script:zero = @{}
$script:queued = New-Object 'System.Collections.Generic.List[object]'
$script:Initialized = $true
$script:LastPrescriptionFullScanAt = $null
$script:flushes = 0
$config = [pscustomobject]@{ sqlServer = 'fixture'; pharmacyId = 4; deviceId = 'fixture'; deviceName = 'fixture'; includeRawQrText = $false }
function Invoke-SqlQuery { param($SqlServer, $DbName, $Query, $TimeoutSeconds) $script:sqlCalls++; $script:query = $Query; return $script:qr }
function Convert-DataTableRows { param($Table) if ($null -ne $Table) { return $Table } }
function Get-PrescriptionDrugs { param($Config, $PrescriptionCode) return $script:drug }
function Read-SyncHashes { param($Kind) if ($Kind -eq 'prescription-zero-drugs') { return ,$script:zero }; return ,$script:hashes }
function Write-SyncHashes { param($Kind, $Hashes) }
function Get-SyncStatePath { param($Kind) return 'fixture-existing-state' }
function Test-Path { param($LiteralPath) return $true }
function Save-QueueItem { param($Envelope) $script:queued.Add($Envelope); return $true }
function Flush-Queue { param($Config) $script:flushes++ }
function Get-QueueFiles { return @() }
function Write-State { param($Config, $Status, $Message) if ($Status -eq 'ERROR') { throw $Message } }
function Write-AgentLog { param($Message, $Level) }
function Write-PharmFarmProgress { param($InstallRoot, $Phase) }

Get-PrescriptionRowsInRange $config '2026-10-26' '2026-11-01' | Out-Null
Assert-Range ($script:query -match "BETWEEN '20261026' AND '20261101'" -and $script:query -notmatch 'TOP') 'Full week SQL includes both endpoints without recent-row limit'
$before = $script:sqlCalls
try { Get-PrescriptionRowsInRange $config 'bad' '2026-11-01' | Out-Null } catch { }
Assert-Range ($before -eq $script:sqlCalls) 'Invalid dates rejected before SQL'
$key = Get-PrescriptionSyncKey $script:qr.ps_Code
$script:hashes[$key] = Get-PrescriptionSnapshotHash $script:qr @($script:drug)
$script:drug.pd_dday = 30
$script:drug.pd_amount = 240
# Fix the clock-independent week fixture while retaining the real range/SQL path.
function Get-PrescriptionWeekRange { return @{ startDate = '2026-10-26'; endDate = '2026-11-01' } }
Watch-Once $config
Assert-Range ($script:queued.Count -eq 1) 'Weekly scan catches a correction to yesterday outside the latest 32'
$envelope = $script:queued[0]
Assert-Range ($envelope.payload.overwriteExisting -and $envelope.payload.items[0].totalQuantity -eq 240) 'Correction uses overwrite path with corrected quantity for stock recalculation'
$script:LastPrescriptionFullScanAt = $null
Watch-Once $config
Assert-Range ($script:queued.Count -eq 1) 'Unchanged weekly snapshots do not resend or deduct twice'
$command = [pscustomobject]@{ payload = [pscustomobject]@{ startDate = '2026-10-27'; endDate = '2026-10-27' } }
$result = Invoke-AgentCommandAction $config $command 'manual-fixture' 'RESYNC_PRESCRIPTIONS_RANGE'
Assert-Range ($result.status -eq 'COMPLETED' -and $result.result.queued -eq 1 -and $result.result.startDate -eq '2026-10-27') 'Manual command routes requested inclusive dates into real collector'
$manual = $script:queued[1]
Assert-Range ($manual.payload.overwriteExisting -and $manual.payload.syncMode -eq 'RANGE_OVERWRITE') 'Manual collection repairs existing prescription through overwrite path'
Assert-Range ($manual.eventId -ne $envelope.eventId) 'Manual request can retry a snapshot already queued or dead-lettered'
function Get-PrescriptionDrugs { param($Config, $PrescriptionCode) return @() }
$summary = Queue-PrescriptionRangeOverwrite $config '2026-10-27' '2026-10-27' 'empty-fixture'
Assert-Range ($summary.queued -eq 0 -and $summary.skipped -eq 1) 'Empty drug snapshot is not sent as a destructive overwrite'
Write-Host "Passed $checks prescription range assertions."
