param(
  [string]$Server = ".\EPHARM_DB",
  [int]$SampleRowsPerTable = 20,
  [int]$MaxCellLength = 240,
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppName = "PharmFarmAgent"
$BaseRoot = Join-Path $env:ProgramData $AppName
$ExportRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  Join-Path $BaseRoot ("debug-export\table-samples-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
} else {
  $OutputRoot
}
$ManifestPath = Join-Path $ExportRoot "manifest.csv"
$ColumnPath = Join-Path $ExportRoot "columns.csv"
$SummaryPath = Join-Path $ExportRoot "summary.txt"
$CodexPath = Join-Path $ExportRoot "SEND_TO_CODEX.txt"

$SensitiveColumnPattern = '(name|patient|jumin|resident|birth|phone|mobile|tel|address|addr|email|ssn|rrn|chart|환자|성명|이름|주민|생년|전화|휴대|주소|차트)'

function Ensure-Directory {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) {
    [void](New-Item -ItemType Directory -Force -Path $Path)
  }
}

function Write-Log {
  param([string]$Message)
  Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message)
}

function New-ConnectionString {
  param(
    [string]$SqlServer,
    [string]$DbName
  )

  return "Server=$SqlServer;Database=$DbName;Integrated Security=True;Connection Timeout=6;Application Name=PharmFarmDebugSamples;"
}

function Invoke-SqlQuery {
  param(
    [string]$SqlServer,
    [string]$DbName,
    [string]$Query,
    [int]$TimeoutSeconds = 30
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

  return $Row.ItemArray[$ordinal]
}

function Quote-SqlName {
  param([string]$Value)
  return "[" + $Value.Replace("]", "]]" ) + "]"
}

function Convert-SafeFilePart {
  param([string]$Value)
  $safe = $Value -replace '[\\/:*?"<>|\s]+', '_'
  if ($safe.Length -gt 80) {
    return $safe.Substring(0, 80)
  }
  return $safe
}

function Convert-SafeCellValue {
  param(
    [string]$ColumnName,
    $Value
  )

  if ($null -eq $Value -or $Value -is [DBNull]) {
    return $null
  }

  if ($ColumnName -match $SensitiveColumnPattern) {
    $text = $Value.ToString()
    if ([string]::IsNullOrWhiteSpace($text)) {
      return ""
    }
    return "[MASKED len=$($text.Length)]"
  }

  if ($Value -is [byte[]]) {
    if ($Value.Length -eq 0) {
      return "0x"
    }
    $take = [Math]::Min($Value.Length, 64)
    $hex = (($Value[0..($take - 1)] | ForEach-Object { $_.ToString("x2") }) -join "")
    if ($Value.Length -gt $take) {
      return "0x$hex... bytes=$($Value.Length)"
    }
    return "0x$hex"
  }

  if ($Value -is [DateTime]) {
    return $Value.ToString("o")
  }

  $textValue = $Value.ToString()
  if ($textValue.Length -gt $MaxCellLength) {
    return $textValue.Substring(0, $MaxCellLength) + "...(truncated len=$($textValue.Length))"
  }

  return $textValue
}

function Export-SafeCsv {
  param(
    [System.Data.DataTable]$Table,
    [string]$Path
  )

  $rows = New-Object System.Collections.Generic.List[object]

  foreach ($row in $Table.Rows) {
    $item = [ordered]@{}

    foreach ($column in $Table.Columns) {
      $item[$column.ColumnName] = Convert-SafeCellValue -ColumnName $column.ColumnName -Value (Get-DataRowValue $row $column.ColumnName)
    }

    $rows.Add([pscustomobject]$item)
  }

  $rows | Export-Csv -LiteralPath $Path -NoTypeInformation -Encoding UTF8
}

function Get-TargetDatabases {
  $query = @"
SELECT name
FROM sys.databases
WHERE database_id > 4
  AND state_desc = 'ONLINE'
  AND (
    name LIKE 'eP[_]%'
    OR name LIKE 'EP[_]%'
    OR name LIKE '%PHARM%'
    OR name LIKE '%EDIS%'
    OR name LIKE '%IETCS%'
  )
ORDER BY name
"@

  $rows = Invoke-SqlQuery -SqlServer $Server -DbName "master" -Query $query -TimeoutSeconds 10
  $items = New-Object System.Collections.Generic.List[string]

  foreach ($row in $rows.Rows) {
    $name = Get-DataRowValue $row "name"
    if ($null -ne $name -and ![string]::IsNullOrWhiteSpace($name.ToString())) {
      $items.Add($name.ToString())
    }
  }

  return @($items.ToArray() | Select-Object -Unique)
}

function Get-TableList {
  param([string]$Database)

  $query = @"
SELECT
  s.name AS schemaName,
  t.name AS tableName,
  SUM(p.rows) AS approxRows,
  COUNT(c.column_id) AS columnCount
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.columns c ON t.object_id = c.object_id
LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
WHERE t.is_ms_shipped = 0
GROUP BY s.name, t.name
ORDER BY SUM(p.rows) DESC, s.name, t.name
"@

  return Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 20
}

function Get-ColumnList {
  param([string]$Database)

  $query = @"
SELECT
  s.name AS schemaName,
  t.name AS tableName,
  c.column_id AS columnId,
  c.name AS columnName,
  ty.name AS typeName,
  c.max_length AS maxLength,
  c.is_nullable AS isNullable
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.columns c ON t.object_id = c.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id
"@

  return Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 20
}

function Get-PreferredOrderColumn {
  param(
    [string]$Database,
    [string]$SchemaName,
    [string]$TableName
  )

  $schemaLiteral = "N'" + $SchemaName.Replace("'", "''") + "'"
  $tableLiteral = "N'" + $TableName.Replace("'", "''") + "'"
  $query = @"
SELECT TOP (1)
  c.name AS columnName
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE s.name = $schemaLiteral
  AND t.name = $tableLiteral
  AND (
    c.is_identity = 1 OR
    ty.name IN ('date', 'datetime', 'datetime2', 'smalldatetime', 'bigint', 'int', 'numeric', 'decimal') OR
    c.name LIKE '%date%' OR c.name LIKE '%time%' OR c.name LIKE '%dt%' OR
    c.name LIKE '%seq%' OR c.name LIKE '%no%' OR c.name LIKE '%id%' OR
    c.name LIKE '%일자%' OR c.name LIKE '%날짜%'
  )
ORDER BY
  CASE
    WHEN c.is_identity = 1 THEN 0
    WHEN ty.name IN ('datetime', 'datetime2', 'smalldatetime', 'date') THEN 1
    WHEN c.name LIKE '%date%' OR c.name LIKE '%time%' OR c.name LIKE '%dt%' OR c.name LIKE '%일자%' OR c.name LIKE '%날짜%' THEN 2
    WHEN c.name LIKE '%seq%' OR c.name LIKE '%no%' OR c.name LIKE '%id%' THEN 3
    ELSE 9
  END,
  c.column_id DESC
"@

  try {
    $rows = Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 8
    foreach ($row in $rows.Rows) {
      $value = Get-DataRowValue $row "columnName"
      if ($null -ne $value -and ![string]::IsNullOrWhiteSpace($value.ToString())) {
        return $value.ToString()
      }
    }
  } catch {
    return ""
  }

  return ""
}

function Export-TableSample {
  param(
    [string]$Database,
    [string]$SchemaName,
    [string]$TableName,
    [int]$ApproxRows
  )

  if ($ApproxRows -le 0) {
    return @{
      status = "EMPTY"
      rows = 0
      file = ""
      orderColumn = ""
      error = ""
    }
  }

  $tableExpr = "$(Quote-SqlName $SchemaName).$(Quote-SqlName $TableName)"
  $orderColumn = Get-PreferredOrderColumn -Database $Database -SchemaName $SchemaName -TableName $TableName
  $orderClause = ""

  if (![string]::IsNullOrWhiteSpace($orderColumn)) {
    $orderClause = " ORDER BY $(Quote-SqlName $orderColumn) DESC"
  }

  $query = "SELECT TOP ($SampleRowsPerTable) * FROM $tableExpr WITH (NOLOCK)$orderClause"

  try {
    $result = Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 45
    $dbDir = Join-Path $ExportRoot (Convert-SafeFilePart $Database)
    Ensure-Directory $dbDir
    $fileName = "{0}.{1}.sample.csv" -f (Convert-SafeFilePart $SchemaName), (Convert-SafeFilePart $TableName)
    $filePath = Join-Path $dbDir $fileName
    Export-SafeCsv -Table $result -Path $filePath

    return @{
      status = "EXPORTED"
      rows = $result.Rows.Count
      file = $filePath
      orderColumn = $orderColumn
      error = ""
    }
  } catch {
    return @{
      status = "QUERY_FAILED"
      rows = 0
      file = ""
      orderColumn = $orderColumn
      error = $_.Exception.Message
    }
  }
}

Ensure-Directory $ExportRoot
Write-Log "table sample export start server=$Server sampleRowsPerTable=$SampleRowsPerTable"
Write-Log "output=$ExportRoot"

$manifest = New-Object System.Collections.Generic.List[object]
$columns = New-Object System.Collections.Generic.List[object]
$databases = Get-TargetDatabases

foreach ($database in $databases) {
  Write-Log "database=$database"

  try {
    $columnRows = Get-ColumnList -Database $database
    foreach ($columnRow in $columnRows.Rows) {
      $columnName = (Get-DataRowValue $columnRow "columnName").ToString()
      $columns.Add([pscustomobject]@{
        database = $database
        schema = (Get-DataRowValue $columnRow "schemaName").ToString()
        table = (Get-DataRowValue $columnRow "tableName").ToString()
        columnId = Get-DataRowValue $columnRow "columnId"
        columnName = $columnName
        typeName = (Get-DataRowValue $columnRow "typeName").ToString()
        maxLength = Get-DataRowValue $columnRow "maxLength"
        isNullable = Get-DataRowValue $columnRow "isNullable"
        maskedInSamples = if ($columnName -match $SensitiveColumnPattern) { "true" } else { "false" }
      })
    }

    $tables = Get-TableList -Database $database
    foreach ($tableRow in $tables.Rows) {
      $schemaName = (Get-DataRowValue $tableRow "schemaName").ToString()
      $tableName = (Get-DataRowValue $tableRow "tableName").ToString()
      $approxRows = [int](Get-DataRowValue $tableRow "approxRows")
      $columnCount = [int](Get-DataRowValue $tableRow "columnCount")
      $export = Export-TableSample -Database $database -SchemaName $schemaName -TableName $tableName -ApproxRows $approxRows
      Write-Log ("{0}.{1}.{2} {3} approx={4} sample={5}" -f $database, $schemaName, $tableName, $export.status, $approxRows, $export.rows)
      $manifest.Add([pscustomobject]@{
        database = $database
        schema = $schemaName
        table = $tableName
        approxRows = $approxRows
        columnCount = $columnCount
        status = $export.status
        sampleRows = $export.rows
        orderColumn = $export.orderColumn
        file = $export.file
        error = $export.error
      })
    }
  } catch {
    $manifest.Add([pscustomobject]@{
      database = $database
      schema = ""
      table = ""
      approxRows = 0
      columnCount = 0
      status = "DATABASE_FAILED"
      sampleRows = 0
      orderColumn = ""
      file = ""
      error = $_.Exception.Message
    })
  }
}

$manifest | Export-Csv -LiteralPath $ManifestPath -NoTypeInformation -Encoding UTF8
$columns | Export-Csv -LiteralPath $ColumnPath -NoTypeInformation -Encoding UTF8
$exportedCount = @($manifest | Where-Object { $_.status -eq "EXPORTED" }).Count
$totalSampleRows = ($manifest | Measure-Object -Property sampleRows -Sum).Sum
Set-Content -LiteralPath $SummaryPath -Encoding UTF8 -Value @(
  "PharmFarm table sample export",
  "CreatedAt=$(Get-Date -Format o)",
  "Server=$Server",
  "SampleRowsPerTable=$SampleRowsPerTable",
  "MaxCellLength=$MaxCellLength",
  "DatabaseCount=$($databases.Count)",
  "ExportedTableCount=$exportedCount",
  "SampleRowCount=$totalSampleRows",
  "Output=$ExportRoot",
  "",
  "Sensitive-looking columns are masked by column name pattern in sample CSV files.",
  "WARNING: Files may still include prescription or pharmacy business data.",
  "Do not upload/share the folder unless legally approved."
)


$topTables = @($manifest | Sort-Object -Property approxRows -Descending | Select-Object -First 80)
$candidateTables = @($manifest | Where-Object {
  $_.table -match '(drug|medi|med|pharm|stock|stk|jego|jaego|pres|prs|edb|order|sale|inventory|약|재고|처방|조제)'
} | Sort-Object -Property approxRows -Descending | Select-Object -First 120)
$candidateColumns = @($columns | Where-Object {
  $_.columnName -match '(iscode|drug|medi|name|qty|quantity|amount|stock|dose|dnum|dday|price|code|pres|date|time|약|재고|처방|조제|수량|보험|코드|약품)'
} | Select-Object -First 300)

$codexLines = New-Object System.Collections.Generic.List[string]
$codexLines.Add('PharmFarm EPharm DB debug summary')
$codexLines.Add('CreatedAt=' + (Get-Date -Format o))
$codexLines.Add('Server=' + $Server)
$codexLines.Add('Output=' + $ExportRoot)
$codexLines.Add('DatabaseCount=' + $databases.Count)
$codexLines.Add('ExportedTableCount=' + $exportedCount)
$codexLines.Add('SampleRowsPerTable=' + $SampleRowsPerTable)
$codexLines.Add('')
$codexLines.Add('HOW TO SHARE')
$codexLines.Add('1. First send this SEND_TO_CODEX.txt file content.')
$codexLines.Add('2. If asked, also send manifest.csv and columns.csv.')
$codexLines.Add('3. Do not send sample CSV files unless specifically requested. They may contain sensitive data.')
$codexLines.Add('')
$codexLines.Add('TOP TABLES BY APPROX ROWS')
foreach ($item in $topTables) {
  $codexLines.Add(('{0}.{1}.{2} rows={3} cols={4} status={5} sampleRows={6} order={7} file={8}' -f $item.database, $item.schema, $item.table, $item.approxRows, $item.columnCount, $item.status, $item.sampleRows, $item.orderColumn, $item.file))
}
$codexLines.Add('')
$codexLines.Add('CANDIDATE TABLES BY NAME')
foreach ($item in $candidateTables) {
  $tableColumns = @($columns | Where-Object { $_.database -eq $item.database -and $_.schema -eq $item.schema -and $_.table -eq $item.table } | Select-Object -First 80)
  $columnText = ($tableColumns | ForEach-Object { $_.columnName + ':' + $_.typeName }) -join ', '
  $codexLines.Add(('{0}.{1}.{2} rows={3} cols={4} status={5} sampleRows={6}' -f $item.database, $item.schema, $item.table, $item.approxRows, $item.columnCount, $item.status, $item.sampleRows))
  $codexLines.Add('  columns=' + $columnText)
  $codexLines.Add('  file=' + $item.file)
}
$codexLines.Add('')
$codexLines.Add('CANDIDATE COLUMNS')
foreach ($col in $candidateColumns) {
  $codexLines.Add(('{0}.{1}.{2}.{3} type={4} masked={5}' -f $col.database, $col.schema, $col.table, $col.columnName, $col.typeName, $col.maskedInSamples))
}
$codexLines.Add('')
$codexLines.Add('STATUS COUNTS')
foreach ($group in ($manifest | Group-Object status | Sort-Object Name)) {
  $codexLines.Add(('{0}={1}' -f $group.Name, $group.Count))
}
$codexLines.Add('')
$codexLines.Add('WARNING')
$codexLines.Add('This summary contains table names, column names, row counts, and local file paths. Sample CSV files may contain sensitive data and should not be shared unless needed.')
Set-Content -LiteralPath $CodexPath -Encoding UTF8 -Value $codexLines

Write-Log "done exportedTables=$exportedCount sampleRows=$totalSampleRows"
Write-Log "manifest=$ManifestPath"
Write-Log "columns=$ColumnPath"
Write-Log "summary=$SummaryPath"
Write-Log "codexSummary=$CodexPath"
Write-Host ""
Write-Host "Open this folder: $ExportRoot"
