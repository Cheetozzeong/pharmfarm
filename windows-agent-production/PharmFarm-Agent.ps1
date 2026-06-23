param(
  [switch]$Console,
  [switch]$Once,
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppName = "PharmFarmAgent"
$DefaultRoot = Join-Path $env:ProgramData $AppName
$InstallRoot = if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $DefaultRoot } else { Split-Path -Parent $ConfigPath }
$ConfigFile = if ([string]::IsNullOrWhiteSpace($ConfigPath)) { Join-Path $InstallRoot "agent.config.json" } else { $ConfigPath }
$QueueDir = Join-Path $InstallRoot "queue"
$SentDir = Join-Path $InstallRoot "sent"
$DeadDir = Join-Path $InstallRoot "dead-letter"
$LogDir = Join-Path $InstallRoot "logs"
$StateFile = Join-Path $InstallRoot "agent.state.json"
$BootstrapStateFile = Join-Path $InstallRoot "bootstrap.state.json"
$LogFile = Join-Path $LogDir ("agent-{0}.log" -f (Get-Date -Format "yyyyMMdd"))
$SeenHashes = @{}
$Initialized = $false

function Ensure-Directory {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) {
    [void](New-Item -ItemType Directory -Force -Path $Path)
  }
}

function Write-AgentLog {
  param(
    [string]$Message,
    [string]$Level = "INFO"
  )

  Ensure-Directory $LogDir
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message

  if ($Console) {
    Write-Host $line
  }

  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Read-JsonFile {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-AgentLog "failed to read json $Path $($_.Exception.Message)" "WARN"
    return $null
  }
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Value,
    [int]$Depth = 20
  )

  $json = $Value | ConvertTo-Json -Depth $Depth
  $tmp = "$Path.tmp"
  Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-Config {
  $config = Read-JsonFile $ConfigFile

  if ($null -eq $config) {
    throw "Missing config: $ConfigFile. Run install-pharmfarm-agent.bat first."
  }

  return $config
}

function Get-Sha256Hex {
  param([string]$Value)

  $sha = [System.Security.Cryptography.SHA256]::Create()

  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha.ComputeHash($bytes)
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha.Dispose()
  }
}

function Convert-NullableDouble {
  param($Value)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace($Value.ToString())) {
    return $null
  }

  try {
    return [double]$Value
  } catch {
    return $null
  }
}

function Convert-NullableInt {
  param($Value)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace($Value.ToString())) {
    return $null
  }

  try {
    return [int]$Value
  } catch {
    return $null
  }
}

function New-ConnectionString {
  param(
    [string]$SqlServer,
    [string]$DbName
  )

  return "Server=$SqlServer;Database=$DbName;Integrated Security=True;Connection Timeout=4;Application Name=PharmFarmAgent;"
}

function Invoke-SqlQuery {
  param(
    [string]$SqlServer,
    [string]$DbName,
    [string]$Query,
    [int]$TimeoutSeconds = 10
  )

  $connection = New-Object System.Data.SqlClient.SqlConnection (New-ConnectionString $SqlServer $DbName)

  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = $Query
    $command.CommandTimeout = $TimeoutSeconds
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $command
    $table = New-Object System.Data.DataTable
    [void]$adapter.Fill($table)
    return ,$table
  } finally {
    $connection.Close()
  }
}

function Quote-SqlLiteral {
  param([string]$Value)
  return "N'" + $Value.Replace("'", "''") + "'"
}

function Get-DataRowValue {
  param(
    [System.Data.DataRow]$Row,
    [string]$ColumnName
  )

  if ($null -eq $Row -or $null -eq $Row.Table) {
    return $null
  }

  $ordinal = $Row.Table.Columns.IndexOf($ColumnName)

  if ($ordinal -lt 0) {
    return $null
  }

  $items = $Row.ItemArray

  if ($null -eq $items -or $items.Length -le $ordinal) {
    return $null
  }

  return $items[$ordinal]
}

function Convert-DataTableRows {
  param([System.Data.DataTable]$Table)

  $rows = New-Object System.Collections.Generic.List[object]

  foreach ($row in $Table.Rows) {
    $item = [ordered]@{}

    foreach ($column in $Table.Columns) {
      $value = Get-DataRowValue $row $column.ColumnName

      if ($null -eq $value -or $value -is [DBNull]) {
        $item[$column.ColumnName] = $null
      } else {
        $item[$column.ColumnName] = $value.ToString()
      }
    }

    $rows.Add($item)
  }

  return $rows.ToArray()
}

function Convert-BootstrapRows {
  param([System.Data.DataTable]$Table)

  $rows = New-Object System.Collections.Generic.List[object]

  foreach ($row in $Table.Rows) {
    $insuranceCode = Get-DataRowValue $row "insuranceCode"
    $drugName = Get-DataRowValue $row "drugName"
    $standardCode = Get-DataRowValue $row "standardCode"
    $unit = Get-DataRowValue $row "unit"
    $price = Get-DataRowValue $row "price"

    if ($null -eq $insuranceCode -and $null -eq $drugName) {
      continue
    }

    $rows.Add([ordered]@{
      insuranceCode = if ($insuranceCode) { $insuranceCode.ToString().Trim() } else { "" }
      drugName = if ($drugName) { $drugName.ToString().Trim() } else { "" }
      standardCode = if ($standardCode) { $standardCode.ToString().Trim() } else { "" }
      unit = if ($unit) { $unit.ToString().Trim() } else { "" }
      price = Convert-NullableDouble $price
    })
  }

  return $rows.ToArray()
}

function Get-DrugMasterRows {
  param(
    [object]$Config,
    [int]$Offset,
    [int]$Limit
  )

  $query = @"
SELECT
  CONVERT(NVARCHAR(80), dm_iscode) AS insuranceCode,
  CONVERT(NVARCHAR(300), dm_drugname) AS drugName,
  CONVERT(NVARCHAR(80), '') AS standardCode,
  CONVERT(NVARCHAR(120), '') AS unit,
  CONVERT(float, NULL) AS price
FROM dbo.dgmast WITH (NOLOCK)
WHERE dm_iscode IS NOT NULL
   OR dm_drugname IS NOT NULL
ORDER BY dm_iscode
OFFSET $Offset ROWS FETCH NEXT $Limit ROWS ONLY
"@

  return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_BASES" -Query $query -TimeoutSeconds 20
}

function Get-DrugMasterCount {
  param([object]$Config)

  $query = @"
SELECT COUNT(1) AS rowCount
FROM dbo.dgmast WITH (NOLOCK)
WHERE dm_iscode IS NOT NULL
   OR dm_drugname IS NOT NULL
"@
  $table = Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_BASES" -Query $query -TimeoutSeconds 10

  foreach ($row in $table.Rows) {
    $value = Get-DataRowValue $row "rowCount"
    if ($null -ne $value) {
      return [int]$value
    }
  }

  return 0
}

function Get-StockCandidateReport {
  param([object]$Config)

  $query = @"
SELECT TOP (40)
  DB_NAME() AS databaseName,
  s.name AS schemaName,
  t.name AS tableName,
  SUM(p.rows) AS rowCount,
  STRING_AGG(CONVERT(NVARCHAR(MAX), c.name), ',') WITHIN GROUP (ORDER BY c.column_id) AS columns
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.columns c ON t.object_id = c.object_id
LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
WHERE
  t.name LIKE '%stock%' OR t.name LIKE '%stk%' OR t.name LIKE '%jae%' OR t.name LIKE '%jego%' OR
  c.name LIKE '%stock%' OR c.name LIKE '%qty%' OR c.name LIKE '%quantity%' OR c.name LIKE '%amount%' OR
  c.name LIKE '%iscode%' OR c.name LIKE '%drug%'
GROUP BY s.name, t.name
HAVING SUM(p.rows) > 0
ORDER BY rowCount DESC, t.name
"@

  $reports = New-Object System.Collections.Generic.List[object]
  $databases = @("eP_PHARM", "eP_BASES", "EP_IETCS", "eP_IETCS")

  foreach ($db in $databases) {
    try {
      $rows = Convert-DataTableRows (Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName $db -Query $query -TimeoutSeconds 12)
      foreach ($row in $rows) {
        $reports.Add($row)
      }
    } catch {
      $reports.Add([ordered]@{
        databaseName = $db
        schemaName = ""
        tableName = ""
        rowCount = 0
        columns = ""
        error = $_.Exception.Message
      })
    }
  }

  return $reports.ToArray()
}

function New-BootstrapEnvelope {
  param(
    [object]$Config,
    [string]$Kind,
    [object]$Data,
    [int]$Part = 1,
    [int]$TotalParts = 1
  )

  $now = (Get-Date).ToUniversalTime().ToString("o")
  $dataJson = $Data | ConvertTo-Json -Depth 20 -Compress
  $eventId = Get-Sha256Hex "$Kind.$Part.$TotalParts.$dataJson"

  return [ordered]@{
    eventId = $eventId
    createdAt = $now
    targetPath = "/samples"
    attempts = 0
    nextAttemptAt = $now
    payload = [ordered]@{
      decoderVersion = "pharmfarm-bootstrap-agent-v1"
      prescriptionGroupId = "bootstrap-" + $Kind
      prescriptionGroupLabel = "초기 동기화 " + $Kind
      qrType = "EPHARM_BOOTSTRAP"
      rawQrText = ""
      rawQrHash = $eventId
      memo = "PharmFarm bootstrap sync / kind=$Kind part=$Part/$TotalParts"
      hospitalName = ""
      patientLabel = ""
      knownPlainText = $dataJson
      knownFields = @(
        [ordered]@{ id = "bootstrapKind"; label = "Bootstrap kind"; type = "OTHER"; value = $Kind; memo = "" },
        [ordered]@{ id = "part"; label = "Part"; type = "OTHER"; value = "$Part/$TotalParts"; memo = "" }
      )
      rawLength = 0
      outerPayloadSize = 0
      outerPayloadHex = ""
      decodeStatus = "PENDING"
      decodeMessage = "Bootstrap data captured by PharmFarm Agent. Server should import into normalized tables."
      decodedText = ""
      answers = @()
      decodedResults = @()
      decodedAt = $now
      createdAt = $now
      updatedAt = $now
    }
  }
}

function Invoke-BootstrapSync {
  param([object]$Config)

  $state = Read-JsonFile $BootstrapStateFile

  if ($null -eq $state) {
    $state = [ordered]@{
      drugMasterCompleted = $false
      stockProbeCompleted = $false
      updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
  }

  if ($Config.bootstrapDrugMaster -eq $true -and $state.drugMasterCompleted -ne $true) {
    try {
      $limit = if ($Config.bootstrapChunkSize) { [int]$Config.bootstrapChunkSize } else { 500 }
      if ($limit -lt 100) { $limit = 100 }
      if ($limit -gt 1000) { $limit = 1000 }
      $totalRows = Get-DrugMasterCount $Config
      $totalParts = [Math]::Max(1, [Math]::Ceiling($totalRows / $limit))
      Write-AgentLog "bootstrap drug master start rows=$totalRows chunk=$limit parts=$totalParts"

      for ($offset = 0; $offset -lt $totalRows; $offset += $limit) {
        $part = [int]([Math]::Floor($offset / $limit) + 1)
        $rows = @(Convert-BootstrapRows (Get-DrugMasterRows -Config $Config -Offset $offset -Limit $limit))
        $data = [ordered]@{
          schema = "pharmfarm.bootstrap.drug-master.v1"
          source = "eP_BASES.dbo.dgmast"
          capturedAt = (Get-Date).ToUniversalTime().ToString("o")
          totalRows = $totalRows
          offset = $offset
          limit = $limit
          rows = $rows
        }
        $envelope = New-BootstrapEnvelope -Config $Config -Kind "drug-master" -Data $data -Part $part -TotalParts $totalParts
        [void](Save-QueueItem $envelope)
        Write-AgentLog "bootstrap drug master queued part=$part/$totalParts rows=$($rows.Count)"
      }

      $state.drugMasterCompleted = $true
      $state.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      Write-JsonFile -Path $BootstrapStateFile -Value $state -Depth 8
    } catch {
      Write-AgentLog "bootstrap drug master error $($_.Exception.Message)" "ERROR"
    }
  }

  if ($Config.bootstrapStockProbe -eq $true -and $state.stockProbeCompleted -ne $true) {
    try {
      $report = @(Get-StockCandidateReport $Config)
      $data = [ordered]@{
        schema = "pharmfarm.bootstrap.stock-candidate-report.v1"
        source = "EPharm SQL catalog"
        capturedAt = (Get-Date).ToUniversalTime().ToString("o")
        note = "This report contains candidate table/column metadata only. It does not include stock row data."
        candidates = $report
      }
      $envelope = New-BootstrapEnvelope -Config $Config -Kind "stock-candidate-report" -Data $data
      [void](Save-QueueItem $envelope)
      $state.stockProbeCompleted = $true
      $state.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      Write-JsonFile -Path $BootstrapStateFile -Value $state -Depth 8
      Write-AgentLog "bootstrap stock candidate report queued candidates=$($report.Count)"
    } catch {
      Write-AgentLog "bootstrap stock probe error $($_.Exception.Message)" "ERROR"
    }
  }
}


function Get-RecentPrescriptionRows {
  param([object]$Config)

  $query = @"
SELECT TOP (8)
  ps_Code,
  ps_Date,
  ps_CnvDef,
  ps_edbBarcode,
  ps_Mcode,
  ps_Mcodetype
FROM dbo.PRESCRIPT_EDB WITH (NOLOCK)
ORDER BY ps_Date DESC, ps_Code DESC
"@

  return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_ERROR_LOG" -Query $query -TimeoutSeconds 8
}

function Get-PrescriptionDrugs {
  param(
    [object]$Config,
    [string]$PrescriptionCode
  )

  $codeLiteral = Quote-SqlLiteral $PrescriptionCode
  $query = @"
SELECT
  d.pd_code,
  d.pd_no,
  d.pd_iscode,
  COALESCE(m.dm_drugname, '') AS drug_name,
  d.pd_dose,
  d.pd_dnum,
  d.pd_dday,
  d.pd_amount
FROM dbo.prsdrug d WITH (NOLOCK)
LEFT JOIN eP_BASES.dbo.dgmast m WITH (NOLOCK)
  ON m.dm_iscode = d.pd_iscode
WHERE d.pd_code = $codeLiteral
ORDER BY d.pd_no
"@

  try {
    return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_PHARM" -Query $query -TimeoutSeconds 10
  } catch {
    $fallback = @"
SELECT
  pd_code,
  pd_no,
  pd_iscode,
  '' AS drug_name,
  pd_dose,
  pd_dnum,
  pd_dday,
  pd_amount
FROM dbo.prsdrug WITH (NOLOCK)
WHERE pd_code = $codeLiteral
ORDER BY pd_no
"@
    return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_PHARM" -Query $fallback -TimeoutSeconds 10
  }
}

function New-Payload {
  param(
    [object]$Config,
    [object]$QrRow,
    [object[]]$DrugRows
  )

  $prescriptionCode = ""
  $qrText = ""

  if ($QrRow.ps_Code) {
    $prescriptionCode = $QrRow.ps_Code.ToString()
  }

  if ($QrRow.ps_edbBarcode -and $Config.includeRawQrText -eq $true) {
    $qrText = $QrRow.ps_edbBarcode.ToString()
  }

  $drugs = New-Object System.Collections.Generic.List[object]
  $answers = New-Object System.Collections.Generic.List[object]
  $decodedResults = New-Object System.Collections.Generic.List[object]

  foreach ($drug in $DrugRows) {
    $lineNo = Convert-NullableInt $drug.pd_no
    $insuranceCode = if ($drug.pd_iscode) { $drug.pd_iscode.ToString() } else { "" }
    $drugName = if ($drug.drug_name) { $drug.drug_name.ToString() } else { "" }
    $quantityPerDose = Convert-NullableDouble $drug.pd_dose
    $dailyFrequency = Convert-NullableInt $drug.pd_dnum
    $medicationDays = Convert-NullableInt $drug.pd_dday
    $totalQuantity = Convert-NullableDouble $drug.pd_amount
    $drugId = "{0}-{1}" -f (Get-Sha256Hex $prescriptionCode).Substring(0, 12), $lineNo

    $drugs.Add([ordered]@{
      lineNo = $lineNo
      insuranceCode = $insuranceCode
      drugName = $drugName
      quantityPerDose = $quantityPerDose
      dailyFrequency = $dailyFrequency
      medicationDays = $medicationDays
      totalQuantity = $totalQuantity
    })

    $answers.Add([ordered]@{
      id = $drugId
      blockType = "EPHARM_PRSDRUG"
      insuranceCode = $insuranceCode
      drugName = $drugName
      quantityPerDose = $quantityPerDose
      dailyFrequency = $dailyFrequency
      medicationDays = $medicationDays
      totalQuantity = $totalQuantity
      memo = "lineNo=$lineNo"
    })

    $decodedResults.Add([ordered]@{
      id = $drugId
      blockType = "EPHARM_PRSDRUG"
      insuranceCode = $insuranceCode
      dailyAmountEstimated = $quantityPerDose
      medicationDays = $medicationDays
      totalQuantityEstimated = $totalQuantity
      confidence = 1
      rawBlock = ""
      decodeNote = "Structured from EPharm prsdrug"
    })
  }

  $identity = [ordered]@{
    source = "EPHARM_DB"
    prescriptionRefHash = Get-Sha256Hex $prescriptionCode
    drugs = $drugs.ToArray()
  }
  $identityJson = $identity | ConvertTo-Json -Depth 20 -Compress
  $eventId = Get-Sha256Hex $identityJson
  $now = (Get-Date).ToUniversalTime().ToString("o")

  return [ordered]@{
    eventId = $eventId
    createdAt = $now
    targetPath = "/samples"
    attempts = 0
    nextAttemptAt = $now
    payload = [ordered]@{
      decoderVersion = "pharmfarm-production-agent-v1"
      prescriptionGroupId = "epharm-" + $eventId.Substring(0, 16)
      prescriptionGroupLabel = "EPharm " + (Get-Date -Format "MM.dd HH:mm")
      qrType = "EPHARM_DB"
      rawQrText = $qrText
      rawQrHash = if ($qrText) { Get-Sha256Hex $qrText } else { $eventId }
      memo = "PharmFarm production agent / source=EPHARM_DB"
      hospitalName = ""
      patientLabel = ""
      knownPlainText = ""
      knownFields = @(
        [ordered]@{
          id = "prescriptionRefHash"
          label = "Prescription reference hash"
          type = "OTHER"
          value = (Get-Sha256Hex $prescriptionCode)
          memo = "Original prescription code is not transmitted."
        }
      )
      rawLength = $qrText.Length
      outerPayloadSize = 0
      outerPayloadHex = ""
      decodeStatus = "PENDING"
      decodeMessage = "Structured EPharm prescription captured by production agent."
      decodedText = ""
      answers = $answers.ToArray()
      decodedResults = $decodedResults.ToArray()
      decodedAt = $now
      createdAt = $now
      updatedAt = $now
    }
  }
}

function Save-QueueItem {
  param([object]$Envelope)

  Ensure-Directory $QueueDir
  $path = Join-Path $QueueDir ("{0}.json" -f $Envelope.eventId)

  if (Test-Path -LiteralPath $path) {
    return $false
  }

  Write-JsonFile -Path $path -Value $Envelope -Depth 30
  return $true
}

function Get-QueueFiles {
  Ensure-Directory $QueueDir
  return @(Get-ChildItem -LiteralPath $QueueDir -Filter "*.json" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
}

function Get-RetryDelaySeconds {
  param([int]$Attempts)

  if ($Attempts -le 0) { return 10 }
  if ($Attempts -eq 1) { return 30 }
  if ($Attempts -eq 2) { return 60 }
  if ($Attempts -eq 3) { return 300 }
  if ($Attempts -eq 4) { return 900 }
  return 1800
}

function New-RequestHeaders {
  param(
    [object]$Config,
    [string]$BodyText
  )

  $headers = @{
    "X-PharmFarm-Agent-Version" = "1.0.0-ps"
    "X-PharmFarm-Device-Id" = $Config.deviceId
  }

  if (![string]::IsNullOrWhiteSpace($Config.agentSecret)) {
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $nonce = [Guid]::NewGuid().ToString("N")
    $bodyHash = Get-Sha256Hex $BodyText
    $signingText = "$timestamp.$nonce.$bodyHash"
    $secretBytes = [Text.Encoding]::UTF8.GetBytes($Config.agentSecret)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList (, $secretBytes)

    try {
      $signatureBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($signingText))
      $headers["X-PharmFarm-Timestamp"] = $timestamp
      $headers["X-PharmFarm-Nonce"] = $nonce
      $headers["X-PharmFarm-Signature"] = (($signatureBytes | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally {
      $hmac.Dispose()
    }
  }

  return $headers
}

function Submit-Envelope {
  param(
    [object]$Config,
    [object]$Envelope
  )

  $url = $Config.apiBase.TrimEnd("/") + $Envelope.targetPath
  $json = $Envelope.payload | ConvertTo-Json -Depth 30 -Compress
  $body = [Text.Encoding]::UTF8.GetBytes($json)
  $headers = New-RequestHeaders -Config $Config -BodyText $json

  try {
    [void](Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json; charset=utf-8" -Headers $headers -Body $body -TimeoutSec 20)
    return @{ ok = $true; retry = $false; status = 200; message = "sent" }
  } catch {
    $statusCode = $null

    if ($_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }

    if ($statusCode -eq 409) {
      return @{ ok = $true; retry = $false; status = 409; message = "duplicate" }
    }

    if ($statusCode -ge 400 -and $statusCode -lt 500) {
      return @{ ok = $false; retry = $false; status = $statusCode; message = $_.Exception.Message }
    }

    return @{ ok = $false; retry = $true; status = $statusCode; message = $_.Exception.Message }
  }
}

function Flush-Queue {
  param([object]$Config)

  Ensure-Directory $SentDir
  Ensure-Directory $DeadDir
  $now = Get-Date
  $files = Get-QueueFiles

  foreach ($file in $files) {
    $envelope = Read-JsonFile $file.FullName

    if ($null -eq $envelope) {
      Move-Item -LiteralPath $file.FullName -Destination (Join-Path $DeadDir $file.Name) -Force
      continue
    }

    if ($envelope.nextAttemptAt) {
      try {
        $nextAttempt = [DateTime]::Parse($envelope.nextAttemptAt)

        if ($nextAttempt.ToUniversalTime() -gt $now.ToUniversalTime()) {
          continue
        }
      } catch {
        # Invalid dates are retried immediately.
      }
    }

    $result = Submit-Envelope -Config $Config -Envelope $envelope

    if ($result.ok) {
      Move-Item -LiteralPath $file.FullName -Destination (Join-Path $SentDir $file.Name) -Force
      Write-AgentLog "sent event=$($envelope.eventId) status=$($result.status)"
      continue
    }

    if (!$result.retry) {
      Move-Item -LiteralPath $file.FullName -Destination (Join-Path $DeadDir $file.Name) -Force
      Write-AgentLog "dead-letter event=$($envelope.eventId) status=$($result.status) $($result.message)" "WARN"
      continue
    }

    $attempts = [int]$envelope.attempts + 1
    $delay = Get-RetryDelaySeconds $attempts
    $envelope.attempts = $attempts
    $envelope.lastError = $result.message
    $envelope.nextAttemptAt = (Get-Date).ToUniversalTime().AddSeconds($delay).ToString("o")
    Write-JsonFile -Path $file.FullName -Value $envelope -Depth 30
    Write-AgentLog "retry scheduled event=$($envelope.eventId) attempts=$attempts delay=${delay}s error=$($result.message)" "WARN"
  }
}

function Write-State {
  param(
    [object]$Config,
    [string]$Status,
    [string]$Message
  )

  $queueCount = (Get-QueueFiles).Count
  $state = [ordered]@{
    status = $Status
    message = $Message
    apiBase = $Config.apiBase
    sqlServer = $Config.sqlServer
    deviceId = $Config.deviceId
    queueCount = $queueCount
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  Write-JsonFile -Path $StateFile -Value $state -Depth 8
}

function Watch-Once {
  param([object]$Config)

  try {
    $rows = @(Convert-DataTableRows (Get-RecentPrescriptionRows $Config))

    if (!$script:Initialized) {
      foreach ($row in $rows) {
        $code = if ($row.ps_Code) { $row.ps_Code.ToString() } else { "" }
        $barcode = if ($row.ps_edbBarcode) { $row.ps_edbBarcode.ToString() } else { "" }
        $script:SeenHashes[(Get-Sha256Hex "$code.$barcode")] = $true
      }

      $script:Initialized = $true
      Write-AgentLog "baseline rows=$($rows.Count)"
      Write-State -Config $Config -Status "OK" -Message "baseline complete"
      return
    }

    foreach ($row in $rows) {
      $code = if ($row.ps_Code) { $row.ps_Code.ToString() } else { "" }
      $barcode = if ($row.ps_edbBarcode) { $row.ps_edbBarcode.ToString() } else { "" }

      if ([string]::IsNullOrWhiteSpace($code)) {
        continue
      }

      $seenKey = Get-Sha256Hex "$code.$barcode"

      if ($script:SeenHashes.ContainsKey($seenKey)) {
        continue
      }

      $script:SeenHashes[$seenKey] = $true
      $drugRows = @(Convert-DataTableRows (Get-PrescriptionDrugs -Config $Config -PrescriptionCode $code))

      if ($drugRows.Count -eq 0) {
        Write-AgentLog "skip prescription=$((Get-Sha256Hex $code).Substring(0, 12)) drugs=0" "WARN"
        continue
      }

      $envelope = New-Payload -Config $Config -QrRow $row -DrugRows $drugRows

      if (Save-QueueItem $envelope) {
        Write-AgentLog "queued event=$($envelope.eventId) drugs=$($drugRows.Count)"
      }
    }

    Flush-Queue $Config
    Write-State -Config $Config -Status "OK" -Message "watch loop complete"
  } catch {
    Write-AgentLog "watch error $($_.Exception.Message)" "ERROR"
    Write-State -Config $Config -Status "ERROR" -Message $_.Exception.Message
  }
}

try {
  Ensure-Directory $InstallRoot
  Ensure-Directory $QueueDir
  Ensure-Directory $SentDir
  Ensure-Directory $DeadDir
  Ensure-Directory $LogDir
  $config = Get-Config
  $intervalSeconds = if ($config.intervalSeconds) { [int]$config.intervalSeconds } else { 10 }

  Write-AgentLog "PharmFarm Agent started api=$($config.apiBase) sql=$($config.sqlServer) interval=${intervalSeconds}s"
  Invoke-BootstrapSync $config
  Flush-Queue $config

  do {
    Watch-Once $config

    if ($Once) {
      break
    }

    Start-Sleep -Seconds $intervalSeconds
  } while ($true)
} catch {
  Write-AgentLog "fatal $($_.Exception.Message)" "ERROR"
  exit 1
}
