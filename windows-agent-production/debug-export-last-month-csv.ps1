param(
  [string]$Server = ".\EPHARM_DB",
  [int]$Days = 31,
  [int]$MaxRowsPerTable = 2000,
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppName = "PharmFarmAgent"
$BaseRoot = Join-Path $env:ProgramData $AppName
$ExportRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  Join-Path $BaseRoot ("debug-export\last-month-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
} else {
  $OutputRoot
}
$ManifestPath = Join-Path $ExportRoot "manifest.csv"
$SummaryPath = Join-Path $ExportRoot "summary.txt"

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

  return "Server=$SqlServer;Database=$DbName;Integrated Security=True;Connection Timeout=6;Application Name=PharmFarmDebugExport;"
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

function Get-DateColumnCandidates {
  param([string]$Database)

  $query = @"
SELECT
  s.name AS schemaName,
  t.name AS tableName,
  c.name AS columnName,
  ty.name AS typeName,
  c.column_id AS columnId
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.columns c ON t.object_id = c.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE t.is_ms_shipped = 0
  AND (
    ty.name IN ('date', 'datetime', 'datetime2', 'smalldatetime')
    OR c.name LIKE '%date%'
    OR c.name LIKE '%time%'
    OR c.name LIKE '%dt%'
    OR c.name LIKE '%일자%'
    OR c.name LIKE '%날짜%'
  )
ORDER BY s.name, t.name,
  CASE
    WHEN ty.name IN ('datetime', 'datetime2', 'smalldatetime', 'date') THEN 0
    WHEN c.name LIKE '%date%' OR c.name LIKE '%time%' THEN 1
    WHEN c.name LIKE '%dt%' THEN 2
    ELSE 9
  END,
  c.column_id
"@

  return Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 20
}

function Get-TableList {
  param([string]$Database)

  $query = @"
SELECT
  s.name AS schemaName,
  t.name AS tableName,
  SUM(p.rows) AS approxRows
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
WHERE t.is_ms_shipped = 0
GROUP BY s.name, t.name
ORDER BY s.name, t.name
"@

  return Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 20
}

function Get-DateExpression {
  param(
    [string]$ColumnName,
    [string]$TypeName
  )

  $column = Quote-SqlName $ColumnName

  if (@("date", "datetime", "datetime2", "smalldatetime") -contains $TypeName.ToLowerInvariant()) {
    return "CONVERT(datetime2, $column)"
  }

  return "COALESCE(TRY_CONVERT(datetime2, $column), TRY_CONVERT(datetime2, CONVERT(nvarchar(64), $column), 112), TRY_CONVERT(datetime2, CONVERT(nvarchar(64), $column), 120), TRY_CONVERT(datetime2, CONVERT(nvarchar(64), $column), 121), TRY_CONVERT(datetime2, CONVERT(nvarchar(64), $column), 23))"
}

function Export-TableByDateColumn {
  param(
    [string]$Database,
    [string]$SchemaName,
    [string]$TableName,
    [object[]]$Candidates
  )

  foreach ($candidate in $Candidates) {
    $columnName = $candidate.columnName.ToString()
    $typeName = $candidate.typeName.ToString()
    $expr = Get-DateExpression -ColumnName $columnName -TypeName $typeName
    $tableExpr = "$(Quote-SqlName $SchemaName).$(Quote-SqlName $TableName)"
    $query = @"
SELECT TOP ($MaxRowsPerTable) *
FROM $tableExpr WITH (NOLOCK)
WHERE $expr >= DATEADD(day, -$Days, GETDATE())
ORDER BY $expr DESC
"@

    try {
      $result = Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 45

      if ($result.Rows.Count -le 0) {
        return @{
          status = "NO_RECENT_ROWS"
          dateColumn = $columnName
          dateColumnType = $typeName
          rows = 0
          file = ""
          error = ""
        }
      }

      $dbDir = Join-Path $ExportRoot (Convert-SafeFilePart $Database)
      Ensure-Directory $dbDir
      $fileName = "{0}.{1}.{2}.csv" -f (Convert-SafeFilePart $SchemaName), (Convert-SafeFilePart $TableName), (Convert-SafeFilePart $columnName)
      $filePath = Join-Path $dbDir $fileName
      $result | Export-Csv -LiteralPath $filePath -NoTypeInformation -Encoding UTF8

      return @{
        status = "EXPORTED"
        dateColumn = $columnName
        dateColumnType = $typeName
        rows = $result.Rows.Count
        file = $filePath
        error = ""
      }
    } catch {
      $lastError = $_.Exception.Message
    }
  }

  return @{
    status = "QUERY_FAILED"
    dateColumn = ""
    dateColumnType = ""
    rows = 0
    file = ""
    error = $lastError
  }
}

Ensure-Directory $ExportRoot
Write-Log "debug export start server=$Server days=$Days maxRowsPerTable=$MaxRowsPerTable"
Write-Log "output=$ExportRoot"

$manifest = New-Object System.Collections.Generic.List[object]
$databases = Get-TargetDatabases

foreach ($database in $databases) {
  Write-Log "database=$database"

  try {
    $tables = Get-TableList -Database $database
    $dateColumns = Get-DateColumnCandidates -Database $database
    $dateMap = @{}

    foreach ($row in $dateColumns.Rows) {
      $schemaName = (Get-DataRowValue $row "schemaName").ToString()
      $tableName = (Get-DataRowValue $row "tableName").ToString()
      $key = "$schemaName.$tableName"

      if (!$dateMap.ContainsKey($key)) {
        $dateMap[$key] = New-Object System.Collections.Generic.List[object]
      }

      $dateMap[$key].Add([pscustomobject]@{
        columnName = (Get-DataRowValue $row "columnName").ToString()
        typeName = (Get-DataRowValue $row "typeName").ToString()
      })
    }

    foreach ($tableRow in $tables.Rows) {
      $schemaName = (Get-DataRowValue $tableRow "schemaName").ToString()
      $tableName = (Get-DataRowValue $tableRow "tableName").ToString()
      $approxRows = Get-DataRowValue $tableRow "approxRows"
      $key = "$schemaName.$tableName"

      if (!$dateMap.ContainsKey($key)) {
        $manifest.Add([pscustomobject]@{
          database = $database
          schema = $schemaName
          table = $tableName
          approxRows = $approxRows
          status = "NO_DATE_COLUMN"
          dateColumn = ""
          dateColumnType = ""
          exportedRows = 0
          file = ""
          error = ""
        })
        continue
      }

      $export = Export-TableByDateColumn -Database $database -SchemaName $schemaName -TableName $tableName -Candidates $dateMap[$key].ToArray()
      Write-Log ("{0}.{1}.{2} {3} rows={4}" -f $database, $schemaName, $tableName, $export.status, $export.rows)
      $manifest.Add([pscustomobject]@{
        database = $database
        schema = $schemaName
        table = $tableName
        approxRows = $approxRows
        status = $export.status
        dateColumn = $export.dateColumn
        dateColumnType = $export.dateColumnType
        exportedRows = $export.rows
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
      status = "DATABASE_FAILED"
      dateColumn = ""
      dateColumnType = ""
      exportedRows = 0
      file = ""
      error = $_.Exception.Message
    })
  }
}

$manifest | Export-Csv -LiteralPath $ManifestPath -NoTypeInformation -Encoding UTF8
$exportedCount = @($manifest | Where-Object { $_.status -eq "EXPORTED" }).Count
$totalRows = ($manifest | Measure-Object -Property exportedRows -Sum).Sum
Set-Content -LiteralPath $SummaryPath -Encoding UTF8 -Value @(
  "PharmFarm debug CSV export",
  "CreatedAt=$(Get-Date -Format o)",
  "Server=$Server",
  "Days=$Days",
  "MaxRowsPerTable=$MaxRowsPerTable",
  "DatabaseCount=$($databases.Count)",
  "ExportedTableCount=$exportedCount",
  "ExportedRowCount=$totalRows",
  "Output=$ExportRoot",
  "",
  "WARNING: These CSV files may include prescription, patient, or pharmacy business data.",
  "Do not upload or share the folder unless legally approved."
)

Write-Log "done exportedTables=$exportedCount exportedRows=$totalRows"
Write-Log "manifest=$ManifestPath"
Write-Log "summary=$SummaryPath"
Write-Host ""
Write-Host "Open this folder: $ExportRoot"
