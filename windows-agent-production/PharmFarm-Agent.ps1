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

function Convert-LogText {
  param(
    [string]$Value,
    [int]$MaxLength = 500
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  $text = ($Value -replace "[\r\n\t]+", " ").Trim()
  if ($text.Length -gt $MaxLength) {
    return $text.Substring(0, $MaxLength) + "...(truncated len=$($text.Length))"
  }

  return $text
}

function Get-ResponseBodyFromException {
  param($ErrorRecord)

  try {
    $response = $ErrorRecord.Exception.Response
    if ($null -eq $response) {
      return ""
    }

    $stream = $response.GetResponseStream()
    if ($null -eq $stream) {
      return ""
    }

    $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8)
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
  } catch {
    return ""
  }
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

function Get-AgentTimestamp {
  return [DateTimeOffset]::Now.ToString("o")
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
    $stockNo = Get-DataRowValue $row "stockNo"
    $drugCode = Get-DataRowValue $row "drugCode"
    $stockViewUnit = Get-DataRowValue $row "stockViewUnit"
    $stockViewQty = Get-DataRowValue $row "stockViewQty"

    if ($null -eq $insuranceCode -and $null -eq $drugName) {
      continue
    }

    $rows.Add([ordered]@{
      insuranceCode = if ($insuranceCode) { $insuranceCode.ToString().Trim() } else { "" }
      drugName = if ($drugName) { $drugName.ToString().Trim() } else { "" }
      stockNo = if ($stockNo) { $stockNo.ToString().Trim() } else { "" }
      drugCode = if ($drugCode) { $drugCode.ToString().Trim() } else { "" }
      stockViewUnit = if ($stockViewUnit) { $stockViewUnit.ToString().Trim() } else { "" }
      stockViewQty = Convert-NullableDouble $stockViewQty
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

  $end = $Offset + $Limit
  $query = @"
SELECT
  q.insuranceCode,
  q.drugName,
  q.stockNo,
  q.drugCode,
  q.stockViewUnit,
  q.stockViewQty
FROM (
  SELECT
    CONVERT(NVARCHAR(80), dm_iscode) AS insuranceCode,
    CONVERT(NVARCHAR(300), dm_drugname) AS drugName,
    CONVERT(NVARCHAR(80), dm_stockno) AS stockNo,
    CONVERT(NVARCHAR(80), dm_drugcode) AS drugCode,
    CONVERT(NVARCHAR(120), dm_StockViewUnit) AS stockViewUnit,
    CONVERT(NVARCHAR(80), dm_StockViewQty) AS stockViewQty,
    ROW_NUMBER() OVER (ORDER BY dm_iscode) AS row_num
  FROM dbo.dgmast WITH (NOLOCK)
  WHERE dm_iscode IS NOT NULL
     OR dm_drugname IS NOT NULL
) q
WHERE q.row_num > $Offset
  AND q.row_num <= $end
ORDER BY q.row_num
"@

  return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_BASES" -Query $query -TimeoutSeconds 20
}

function Get-StockRows {
  param(
    [object]$Config,
    [int]$Offset,
    [int]$Limit
  )

  $end = $Offset + $Limit
  $query = @"
SELECT
  q.insuranceCode,
  q.stockNo,
  q.stockQuantity,
  q.fairStockQuantity,
  q.buyDate,
  q.buyPrice,
  q.corporationCode
FROM (
  SELECT
    CONVERT(NVARCHAR(80), so_IsCode) AS insuranceCode,
    CONVERT(NVARCHAR(80), so_SNo) AS stockNo,
    CONVERT(NVARCHAR(80), so_Stock) AS stockQuantity,
    CONVERT(NVARCHAR(80), so_FairStock) AS fairStockQuantity,
    CONVERT(NVARCHAR(40), so_BuyDate) AS buyDate,
    CONVERT(NVARCHAR(80), so_BuyPrice) AS buyPrice,
    CONVERT(NVARCHAR(80), so_CorpCode) AS corporationCode,
    ROW_NUMBER() OVER (ORDER BY so_IsCode, so_SNo) AS row_num
  FROM dbo.STOCK WITH (NOLOCK)
  WHERE so_IsCode IS NOT NULL
) q
WHERE q.row_num > $Offset
  AND q.row_num <= $end
ORDER BY q.row_num
"@

  return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_PHARM" -Query $query -TimeoutSeconds 20
}

function Get-TableCount {
  param(
    [object]$Config,
    [string]$DbName,
    [string]$TableName,
    [string]$Where = "1=1"
  )

  $query = "SELECT COUNT(1) AS row_count FROM $TableName WITH (NOLOCK) WHERE $Where"
  $table = Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName $DbName -Query $query -TimeoutSeconds 10

  foreach ($row in $table.Rows) {
    $value = Get-DataRowValue $row "row_count"
    if ($null -ne $value) {
      return [int]$value
    }
  }

  return 0
}

function Get-BarcodeRows {
  param(
    [object]$Config,
    [int]$Offset,
    [int]$Limit
  )

  $end = $Offset + $Limit
  $query = @"
SELECT
  q.barcode,
  q.insuranceCode,
  q.drugCode,
  q.extBarcode,
  q.majorBarcode,
  q.packAmount,
  q.amount,
  q.unit
FROM (
  SELECT
    CONVERT(NVARCHAR(160), db_barcode) AS barcode,
    CONVERT(NVARCHAR(80), db_iscode) AS insuranceCode,
    CONVERT(NVARCHAR(80), db_drugcode) AS drugCode,
    CONVERT(NVARCHAR(160), db_extbarcode) AS extBarcode,
    CONVERT(NVARCHAR(160), db_majbarcode) AS majorBarcode,
    CONVERT(NVARCHAR(80), db_packamt) AS packAmount,
    CONVERT(NVARCHAR(80), db_amt) AS amount,
    CONVERT(NVARCHAR(80), db_unit) AS unit,
    ROW_NUMBER() OVER (ORDER BY db_barcode) AS row_num
  FROM dbo.dgbarcode WITH (NOLOCK)
  WHERE db_barcode IS NOT NULL
) q
WHERE q.row_num > $Offset
  AND q.row_num <= $end
ORDER BY q.row_num
"@

  return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_BASES" -Query $query -TimeoutSeconds 20
}

function Get-WholesalerRows {
  param(
    [object]$Config,
    [int]$Offset,
    [int]$Limit
  )

  $end = $Offset + $Limit
  $query = @"
SELECT
  q.externalCode,
  q.name,
  q.corporationName,
  q.businessNumber,
  q.phone,
  q.address,
  q.nimsCode,
  q.nimsName,
  q.active
FROM (
  SELECT
    CONVERT(NVARCHAR(80), dcp_code) AS externalCode,
    CONVERT(NVARCHAR(300), dcp_dealname) AS name,
    CONVERT(NVARCHAR(300), dcp_corpname) AS corporationName,
    CONVERT(NVARCHAR(80), dcp_corpno) AS businessNumber,
    CONVERT(NVARCHAR(120), dcp_tel) AS phone,
    CONVERT(NVARCHAR(500), dcp_addr) AS address,
    CONVERT(NVARCHAR(160), DCP_NIMS_BSSH_CD) AS nimsCode,
    CONVERT(NVARCHAR(300), DCP_NIMS_BSSH_NM) AS nimsName,
    CONVERT(NVARCHAR(20), dcp_used) AS active,
    ROW_NUMBER() OVER (ORDER BY dcp_code) AS row_num
  FROM dbo.dealcorp WITH (NOLOCK)
  WHERE dcp_code IS NOT NULL
) q
WHERE q.row_num > $Offset
  AND q.row_num <= $end
ORDER BY q.row_num
"@

  return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_BASES" -Query $query -TimeoutSeconds 20
}

function Get-PurchaseRows {
  param(
    [object]$Config,
    [int]$Offset,
    [int]$Limit
  )

  $end = $Offset + $Limit
  $query = @"
SELECT
  q.tradeCode,
  q.tradeDate,
  q.wholesalerCode,
  q.wholesalerName,
  q.lineNo,
  q.insuranceCode,
  q.drugName,
  q.quantity,
  q.price,
  q.lot,
  q.exp,
  q.sgtinKey
FROM (
  SELECT
    CONVERT(NVARCHAR(80), t.TR_CODE) AS tradeCode,
    CONVERT(NVARCHAR(40), t.TR_DATE) AS tradeDate,
    CONVERT(NVARCHAR(80), t.TR_DEALCORP) AS wholesalerCode,
    CONVERT(NVARCHAR(300), c.dcp_dealname) AS wholesalerName,
    CONVERT(NVARCHAR(80), d.TD_SEQ) AS lineNo,
    CONVERT(NVARCHAR(80), d.TD_ISCODE) AS insuranceCode,
    CONVERT(NVARCHAR(300), d.TD_DRUGNAME) AS drugName,
    CONVERT(NVARCHAR(80), d.TD_AMOUNT) AS quantity,
    CONVERT(NVARCHAR(80), d.TD_PRICE) AS price,
    CONVERT(NVARCHAR(160), d.TD_MMF_NO) AS lot,
    CONVERT(NVARCHAR(40), d.TD_TERMDATE) AS exp,
    CONVERT(NVARCHAR(300), d.TD_SGTIN_KEY) AS sgtinKey,
    ROW_NUMBER() OVER (ORDER BY t.TR_CODE DESC, d.TD_SEQ) AS row_num
  FROM dbo.TRADE t WITH (NOLOCK)
  JOIN dbo.tradedrug d WITH (NOLOCK)
    ON d.TD_CODE = t.TR_CODE
  LEFT JOIN eP_BASES.dbo.dealcorp c WITH (NOLOCK)
    ON c.dcp_code = t.TR_DEALCORP
) q
WHERE q.row_num > $Offset
  AND q.row_num <= $end
ORDER BY q.row_num
"@

  return Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_PHARM" -Query $query -TimeoutSeconds 20
}

function Get-DrugMasterCount {
  param([object]$Config)

  $query = @"
SELECT COUNT(1) AS row_count
FROM dbo.dgmast WITH (NOLOCK)
WHERE dm_iscode IS NOT NULL
   OR dm_drugname IS NOT NULL
"@
  $table = Invoke-SqlQuery -SqlServer $Config.sqlServer -DbName "eP_BASES" -Query $query -TimeoutSeconds 10

  foreach ($row in $table.Rows) {
    $value = Get-DataRowValue $row "row_count"
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

  $now = Get-AgentTimestamp
  $dataJson = $Data | ConvertTo-Json -Depth 20 -Compress
  $eventId = Get-Sha256Hex "$Kind.$Part.$TotalParts.$dataJson"

  return [ordered]@{
    eventId = $eventId
    createdAt = $now
    targetPath = "/agent/disabled-bootstrap"
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

function New-AgentEnvelope {
  param(
    [object]$Config,
    [string]$Kind,
    [string]$TargetPath,
    [object[]]$Items,
    [int]$Part = 1,
    [int]$TotalParts = 1
  )

  $now = Get-AgentTimestamp
  $itemsJson = $Items | ConvertTo-Json -Depth 24 -Compress
  $eventId = Get-Sha256Hex "$Kind.$Part.$TotalParts.$itemsJson"

  return [ordered]@{
    eventId = $eventId
    createdAt = $now
    targetPath = $TargetPath
    attempts = 0
    nextAttemptAt = $now
    payload = [ordered]@{
      pharmacyId = Convert-NullableInt $Config.pharmacyId
      deviceId = $Config.deviceId
      deviceName = $Config.deviceName
      agentVersion = "1.1.0-ps"
      batchId = "$Kind-$($eventId.Substring(0, 16))-$Part-$TotalParts"
      capturedAt = $now
      items = $Items
    }
  }
}

function Queue-AgentTableSync {
  param(
    [object]$Config,
    [object]$State,
    [string]$StateKey,
    [string]$Kind,
    [string]$TargetPath,
    [string]$DbName,
    [string]$TableName,
    [scriptblock]$FetchRows,
    [string]$Where = "1=1"
  )

  if ($State.$StateKey -eq $true) {
    return
  }

  try {
    $limit = if ($Config.bootstrapChunkSize) { [int]$Config.bootstrapChunkSize } else { 500 }
    if ($limit -lt 100) { $limit = 100 }
    if ($limit -gt 1000) { $limit = 1000 }
    $totalRows = Get-TableCount -Config $Config -DbName $DbName -TableName $TableName -Where $Where
    $totalParts = [Math]::Max(1, [Math]::Ceiling($totalRows / $limit))
    Write-AgentLog "bootstrap $Kind start rows=$totalRows chunk=$limit parts=$totalParts"

    for ($offset = 0; $offset -lt $totalRows; $offset += $limit) {
      $part = [int]([Math]::Floor($offset / $limit) + 1)
      $rows = @(Convert-DataTableRows (& $FetchRows $Config $offset $limit))
      $envelope = New-AgentEnvelope -Config $Config -Kind $Kind -TargetPath $TargetPath -Items $rows -Part $part -TotalParts $totalParts
      [void](Save-QueueItem $envelope)
      Write-AgentLog "bootstrap $Kind queued part=$part/$totalParts rows=$($rows.Count)"
    }

    $State.$StateKey = $true
    $State.updatedAt = Get-AgentTimestamp
    Write-JsonFile -Path $BootstrapStateFile -Value $State -Depth 8
  } catch {
    Write-AgentLog "bootstrap $Kind error $($_.Exception.Message)" "ERROR"
  }
}

function Invoke-BootstrapSync {
  param([object]$Config)

  $state = Read-JsonFile $BootstrapStateFile

  if ($null -eq $state) {
    $state = [pscustomobject][ordered]@{
      drugMasterCompleted = $false
      stockProbeCompleted = $false
      stockCompleted = $false
      barcodeCompleted = $false
      wholesalerCompleted = $false
      purchaseCompleted = $false
      updatedAt = Get-AgentTimestamp
    }
  }

  foreach ($stateKey in @("drugMasterCompleted", "stockProbeCompleted", "stockCompleted", "barcodeCompleted", "wholesalerCompleted", "purchaseCompleted")) {
    if ($null -eq $state.PSObject.Properties[$stateKey]) {
      $state | Add-Member -NotePropertyName $stateKey -NotePropertyValue $false
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
        $envelope = New-AgentEnvelope -Config $Config -Kind "drug-master" -TargetPath "/agent/drug-masters" -Items $rows -Part $part -TotalParts $totalParts
        [void](Save-QueueItem $envelope)
        Write-AgentLog "bootstrap drug master queued part=$part/$totalParts rows=$($rows.Count)"
      }

      $state.drugMasterCompleted = $true
      $state.updatedAt = Get-AgentTimestamp
      Write-JsonFile -Path $BootstrapStateFile -Value $state -Depth 8
    } catch {
      Write-AgentLog "bootstrap drug master error $($_.Exception.Message)" "ERROR"
    }
  }

  if ($Config.bootstrapStock -eq $true -or $Config.bootstrapStocks -eq $true) {
    Queue-AgentTableSync -Config $Config -State $state -StateKey "stockCompleted" -Kind "stock" -TargetPath "/agent/stocks" -DbName "eP_PHARM" -TableName "dbo.STOCK" -Where "so_IsCode IS NOT NULL" -FetchRows { param($c, $o, $l) Get-StockRows -Config $c -Offset $o -Limit $l }
  }

  if ($Config.bootstrapBarcode -eq $true -or $Config.bootstrapBarcodes -eq $true) {
    Queue-AgentTableSync -Config $Config -State $state -StateKey "barcodeCompleted" -Kind "barcode" -TargetPath "/agent/barcodes" -DbName "eP_BASES" -TableName "dbo.dgbarcode" -Where "db_barcode IS NOT NULL" -FetchRows { param($c, $o, $l) Get-BarcodeRows -Config $c -Offset $o -Limit $l }
  }

  if ($Config.bootstrapWholesaler -eq $true -or $Config.bootstrapWholesalers -eq $true) {
    Queue-AgentTableSync -Config $Config -State $state -StateKey "wholesalerCompleted" -Kind "wholesaler" -TargetPath "/agent/wholesalers" -DbName "eP_BASES" -TableName "dbo.dealcorp" -Where "dcp_code IS NOT NULL" -FetchRows { param($c, $o, $l) Get-WholesalerRows -Config $c -Offset $o -Limit $l }
  }

  if ($Config.bootstrapPurchase -eq $true -or $Config.bootstrapPurchases -eq $true) {
    Queue-AgentTableSync -Config $Config -State $state -StateKey "purchaseCompleted" -Kind "purchase" -TargetPath "/agent/purchases" -DbName "eP_PHARM" -TableName "dbo.tradedrug" -Where "TD_CODE IS NOT NULL" -FetchRows { param($c, $o, $l) Get-PurchaseRows -Config $c -Offset $o -Limit $l }
  }

  if ($false -and $Config.bootstrapStockProbe -eq $true -and $state.stockProbeCompleted -ne $true) {
    try {
      $report = @(Get-StockCandidateReport $Config)
      $data = [ordered]@{
        schema = "pharmfarm.bootstrap.stock-candidate-report.v1"
        source = "EPharm SQL catalog"
        capturedAt = Get-AgentTimestamp
        note = "This report contains candidate table/column metadata only. It does not include stock row data."
        candidates = $report
      }
      $envelope = New-BootstrapEnvelope -Config $Config -Kind "stock-candidate-report" -Data $data
      [void](Save-QueueItem $envelope)
      $state.stockProbeCompleted = $true
      $state.updatedAt = Get-AgentTimestamp
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

  $items = New-Object System.Collections.Generic.List[object]
  $psDate = if ($QrRow.ps_Date) { $QrRow.ps_Date.ToString() } else { "" }

  foreach ($drug in $DrugRows) {
    $lineNo = Convert-NullableInt $drug.pd_no
    $insuranceCode = if ($drug.pd_iscode) { $drug.pd_iscode.ToString() } else { "" }
    $drugName = if ($drug.drug_name) { $drug.drug_name.ToString() } else { "" }
    $quantityPerDose = Convert-NullableDouble $drug.pd_dose
    $dailyFrequency = Convert-NullableInt $drug.pd_dnum
    $medicationDays = Convert-NullableInt $drug.pd_dday
    $totalQuantity = Convert-NullableDouble $drug.pd_amount

    $items.Add([ordered]@{
      prescriptionCode = $prescriptionCode
      pd_code = $prescriptionCode
      ps_code = $prescriptionCode
      ps_dosdate = $psDate
      lineNo = $lineNo
      pd_no = $lineNo
      insuranceCode = $insuranceCode
      pd_iscode = $insuranceCode
      drugName = $drugName
      drug_name = $drugName
      quantityPerDose = $quantityPerDose
      pd_dose = $quantityPerDose
      dailyFrequency = $dailyFrequency
      pd_dnum = $dailyFrequency
      medicationDays = $medicationDays
      pd_dday = $medicationDays
      totalQuantity = $totalQuantity
      pd_amount = $totalQuantity
    })
  }

  $identity = [ordered]@{
    source = "EPHARM_DB"
    prescriptionRefHash = Get-Sha256Hex $prescriptionCode
    drugs = $items.ToArray()
  }
  $identityJson = $identity | ConvertTo-Json -Depth 20 -Compress
  $eventId = Get-Sha256Hex $identityJson
  $now = Get-AgentTimestamp

  return [ordered]@{
    eventId = $eventId
    createdAt = $now
    targetPath = "/agent/prescriptions"
    attempts = 0
    nextAttemptAt = $now
    payload = [ordered]@{
      pharmacyId = Convert-NullableInt $Config.pharmacyId
      deviceId = $Config.deviceId
      deviceName = $Config.deviceName
      agentVersion = "1.1.0-ps"
      batchId = "prescription-$($eventId.Substring(0, 16))"
      capturedAt = $now
      items = $items.ToArray()
    }
  }
}

function Save-QueueItem {
  param([object]$Envelope)

  Ensure-Directory $QueueDir
  $path = Join-Path $QueueDir ("{0}.json" -f $Envelope.eventId)

  if (Test-Path -LiteralPath $path) {
    Write-AgentLog "queue duplicate event=$($Envelope.eventId) path=$path" "WARN"
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

  if ($Config.pharmacyId) {
    $headers["X-PharmFarm-Pharmacy-Id"] = $Config.pharmacyId.ToString()
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
  $itemCount = if ($Envelope.payload.items) { $Envelope.payload.items.Count } else { 0 }

  try {
    Write-AgentLog "submit start event=$($Envelope.eventId) url=$url bytes=$($body.Length) items=$itemCount pharmacyId=$($Config.pharmacyId)"
    [void](Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json; charset=utf-8" -Headers $headers -Body $body -TimeoutSec 20)
    return @{ ok = $true; retry = $false; status = 200; message = "sent" }
  } catch {
    $statusCode = $null
    $responseBody = Get-ResponseBodyFromException $_
    $safeBody = Convert-LogText $responseBody

    if ($_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }

    Write-AgentLog "submit failed event=$($Envelope.eventId) status=$statusCode error=$($_.Exception.Message) response=$safeBody" "WARN"

    if ($statusCode -eq 409) {
      return @{ ok = $true; retry = $false; status = 409; message = "duplicate" }
    }

    if ($statusCode -ge 400 -and $statusCode -lt 500) {
      $message = $_.Exception.Message
      if (![string]::IsNullOrWhiteSpace($safeBody)) {
        $message = "$message response=$safeBody"
      }
      return @{ ok = $false; retry = $false; status = $statusCode; message = $message }
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

  if ($files.Count -gt 0) {
    Write-AgentLog "flush queue count=$($files.Count)"
  }

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
    $envelope.nextAttemptAt = [DateTimeOffset]::Now.AddSeconds($delay).ToString("o")
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
    pharmacyId = $Config.pharmacyId
    deviceId = $Config.deviceId
    queueCount = $queueCount
    updatedAt = Get-AgentTimestamp
  }

  Write-JsonFile -Path $StateFile -Value $state -Depth 8
}

function Watch-Once {
  param([object]$Config)

  try {
    $rows = @(Convert-DataTableRows (Get-RecentPrescriptionRows $Config))
    $latest = if ($rows.Count -gt 0) { $rows[0] } else { $null }
    if ($null -ne $latest) {
      $latestCode = if ($latest.ps_Code) { $latest.ps_Code.ToString() } else { "" }
      $latestDate = if ($latest.ps_Date) { $latest.ps_Date.ToString() } else { "" }
      $latestBarcodeLen = if ($latest.ps_edbBarcode) { $latest.ps_edbBarcode.ToString().Length } else { 0 }
      $latestHash = if (![string]::IsNullOrWhiteSpace($latestCode)) { (Get-Sha256Hex $latestCode).Substring(0, 12) } else { "" }
      Write-AgentLog "watch scan rows=$($rows.Count) initialized=$script:Initialized latestHash=$latestHash latestDate=$latestDate latestBarcodeLen=$latestBarcodeLen includeRawQr=$($Config.includeRawQrText)"
    } else {
      Write-AgentLog "watch scan rows=0 initialized=$script:Initialized includeRawQr=$($Config.includeRawQrText)" "WARN"
    }

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

      $drugRows = @(Convert-DataTableRows (Get-PrescriptionDrugs -Config $Config -PrescriptionCode $code))

      if ($drugRows.Count -eq 0) {
        Write-AgentLog "pending prescription=$((Get-Sha256Hex $code).Substring(0, 12)) drugs=0 willRetry=true" "WARN"
        continue
      }

      $script:SeenHashes[$seenKey] = $true
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

  if (!$config.pharmacyId) {
    Write-AgentLog "missing pharmacyId in config. Re-run installer and enter CMS pharmacy ID." "ERROR"
    Write-State -Config $config -Status "ERROR" -Message "missing pharmacyId"
    exit 1
  }

  Write-AgentLog "PharmFarm Agent started api=$($config.apiBase) sql=$($config.sqlServer) interval=${intervalSeconds}s pharmacyId=$($config.pharmacyId) deviceId=$($config.deviceId) includeRawQr=$($config.includeRawQrText) secretConfigured=$(![string]::IsNullOrWhiteSpace($config.agentSecret))"
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
