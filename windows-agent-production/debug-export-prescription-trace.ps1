param(
  [string]$Server = ".\EPHARM_DB",
  [string]$PrescriptionCode = "202607010027",
  [string[]]$InsuranceCode = @("629700750", "657300850"),
  [string]$OutputRoot = "",
  [int]$MaxRowsPerTable = 200
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppName = "PharmFarmAgent"
$BaseRoot = Join-Path $env:ProgramData $AppName
$safePrescriptionCode = $PrescriptionCode -replace '[\\/:*?"<>|\s]+', '_'
$ExportRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  Join-Path $BaseRoot ("debug-export\prescription-trace-{0}-{1}" -f $safePrescriptionCode, (Get-Date -Format "yyyyMMdd-HHmmss"))
} else {
  $OutputRoot
}
$ManifestPath = Join-Path $ExportRoot "manifest.csv"
$ColumnPath = Join-Path $ExportRoot "candidate_columns.csv"
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

  return "Server=$SqlServer;Database=$DbName;Integrated Security=True;Connection Timeout=6;Application Name=PharmFarmPrescriptionTrace;"
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

function Quote-SqlLiteral {
  param([string]$Value)
  return "N'" + $Value.Replace("'", "''") + "'"
}

function Convert-SafeFilePart {
  param([string]$Value)
  $safe = $Value -replace '[\\/:*?"<>|\s]+', '_'
  if ($safe.Length -gt 90) {
    return $safe.Substring(0, 90)
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

  return $Value.ToString()
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

function Add-ManifestRow {
  param(
    [System.Collections.Generic.List[object]]$Manifest,
    [string]$Kind,
    [string]$Database,
    [string]$SchemaName,
    [string]$TableName,
    [string]$Status,
    [int]$Rows,
    [string]$File,
    [string]$Error
  )

  $Manifest.Add([pscustomobject]@{
    kind = $Kind
    database = $Database
    schema = $SchemaName
    table = $TableName
    status = $Status
    rows = $Rows
    file = $File
    error = $Error
  })
}

function Export-QueryResult {
  param(
    [System.Collections.Generic.List[object]]$Manifest,
    [string]$Kind,
    [string]$Database,
    [string]$SchemaName,
    [string]$TableName,
    [string]$Query,
    [string]$FileName,
    [int]$TimeoutSeconds = 30,
    [bool]$WriteEmpty = $true
  )

  try {
    $result = Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $Query -TimeoutSeconds $TimeoutSeconds
    $filePath = ""
    if ($WriteEmpty -or $result.Rows.Count -gt 0) {
      $dbDir = Join-Path $ExportRoot (Convert-SafeFilePart $Database)
      Ensure-Directory $dbDir
      $filePath = Join-Path $dbDir $FileName
      Export-SafeCsv -Table $result -Path $filePath
    }
    Write-Log ("{0} {1}.{2}.{3} rows={4}" -f $Kind, $Database, $SchemaName, $TableName, $result.Rows.Count)
    Add-ManifestRow -Manifest $Manifest -Kind $Kind -Database $Database -SchemaName $SchemaName -TableName $TableName -Status "EXPORTED" -Rows $result.Rows.Count -File $filePath -Error ""
    return $result.Rows.Count
  } catch {
    Write-Log ("{0} {1}.{2}.{3} failed {4}" -f $Kind, $Database, $SchemaName, $TableName, $_.Exception.Message)
    Add-ManifestRow -Manifest $Manifest -Kind $Kind -Database $Database -SchemaName $SchemaName -TableName $TableName -Status "QUERY_FAILED" -Rows 0 -File "" -Error $_.Exception.Message
    return 0
  }
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

function Get-CandidateColumns {
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
  AND (
    t.name LIKE '%pres%'
    OR t.name LIKE '%prs%'
    OR t.name LIKE '%edb%'
    OR t.name LIKE '%drug%'
    OR t.name LIKE '%medi%'
    OR t.name LIKE '%order%'
    OR t.name LIKE '%change%'
    OR t.name LIKE '%sub%'
    OR c.name LIKE '%code%'
    OR c.name LIKE '%iscode%'
    OR c.name LIKE '%drug%'
    OR c.name LIKE '%pres%'
    OR c.name LIKE '%prs%'
    OR c.name LIKE '%sub%'
    OR c.name LIKE '%org%'
    OR c.name LIKE '%ori%'
    OR c.name LIKE '%chg%'
    OR c.name LIKE '%cnv%'
  )
ORDER BY s.name, t.name, c.column_id
"@

  return Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 20
}

function Get-SearchableColumns {
  param([string]$Database)

  $query = @"
SELECT
  s.name AS schemaName,
  t.name AS tableName,
  c.name AS columnName,
  ty.name AS typeName
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.columns c ON t.object_id = c.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE t.is_ms_shipped = 0
  AND ty.name IN ('char', 'nchar', 'varchar', 'nvarchar', 'text', 'ntext')
  AND (
    c.name LIKE '%code%'
    OR c.name LIKE '%iscode%'
    OR c.name LIKE '%drug%'
    OR c.name LIKE '%pres%'
    OR c.name LIKE '%prs%'
    OR c.name LIKE '%sub%'
    OR c.name LIKE '%org%'
    OR c.name LIKE '%ori%'
    OR c.name LIKE '%chg%'
    OR c.name LIKE '%cnv%'
    OR t.name LIKE '%pres%'
    OR t.name LIKE '%prs%'
    OR t.name LIKE '%edb%'
    OR t.name LIKE '%drug%'
    OR t.name LIKE '%medi%'
    OR t.name LIKE '%order%'
    OR t.name LIKE '%change%'
    OR t.name LIKE '%sub%'
  )
ORDER BY s.name, t.name, c.column_id
"@

  return Invoke-SqlQuery -SqlServer $Server -DbName $Database -Query $query -TimeoutSeconds 20
}

function Export-ValueMatches {
  param(
    [System.Collections.Generic.List[object]]$Manifest,
    [string]$Kind,
    [string]$Database,
    [object[]]$ColumnRows,
    [string[]]$Values
  )

  $cleanValues = @($Values | Where-Object { ![string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  if ($cleanValues.Count -eq 0) {
    return
  }

  $valueList = ($cleanValues | ForEach-Object { Quote-SqlLiteral $_ }) -join ", "
  $groups = @($ColumnRows | Group-Object -Property schemaName, tableName)

  foreach ($group in $groups) {
    $first = $group.Group[0]
    $schemaName = $first.schemaName.ToString()
    $tableName = $first.tableName.ToString()
    $tableExpr = "$(Quote-SqlName $schemaName).$(Quote-SqlName $tableName)"
    $conditions = @($group.Group | ForEach-Object {
      "CONVERT(NVARCHAR(4000), $(Quote-SqlName $_.columnName.ToString())) IN ($valueList)"
    })

    if ($conditions.Count -eq 0) {
      continue
    }

    $where = $conditions -join " OR "
    $query = "SELECT TOP ($MaxRowsPerTable) * FROM $tableExpr WITH (NOLOCK) WHERE $where"
    $fileName = "{0}.{1}.{2}.csv" -f $Kind, (Convert-SafeFilePart $schemaName), (Convert-SafeFilePart $tableName)
    [void](Export-QueryResult -Manifest $Manifest -Kind $Kind -Database $Database -SchemaName $schemaName -TableName $tableName -Query $query -FileName $fileName -TimeoutSeconds 45 -WriteEmpty $false)
  }
}

Ensure-Directory $ExportRoot
Write-Log "prescription trace export start server=$Server prescriptionCode=$PrescriptionCode"
Write-Log "insuranceCode=$($InsuranceCode -join ',')"
Write-Log "output=$ExportRoot"

$manifest = New-Object System.Collections.Generic.List[object]
$allColumns = New-Object System.Collections.Generic.List[object]
$prescriptionLiteral = Quote-SqlLiteral $PrescriptionCode
$insuranceValues = @($InsuranceCode | Where-Object { ![string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
$insuranceList = ($insuranceValues | ForEach-Object { Quote-SqlLiteral $_ }) -join ", "

[void](Export-QueryResult -Manifest $manifest -Kind "prescription-edb" -Database "eP_ERROR_LOG" -SchemaName "dbo" -TableName "PRESCRIPT_EDB" -Query "SELECT * FROM dbo.PRESCRIPT_EDB WITH (NOLOCK) WHERE ps_Code = $prescriptionLiteral ORDER BY ps_Date DESC, ps_Code DESC" -FileName "prescription-edb.PRESCRIPT_EDB.csv" -TimeoutSeconds 15)

[void](Export-QueryResult -Manifest $manifest -Kind "prsdrug-raw" -Database "eP_PHARM" -SchemaName "dbo" -TableName "prsdrug" -Query "SELECT * FROM dbo.prsdrug WITH (NOLOCK) WHERE pd_code = $prescriptionLiteral ORDER BY pd_no" -FileName "prsdrug.raw.csv" -TimeoutSeconds 15)

$joinedQuery = @"
SELECT
  d.*,
  m.dm_drugname AS master_drug_name,
  m.dm_drugcode AS master_drug_code,
  m.dm_stockno AS master_stock_no,
  m.dm_extype AS master_exception_type,
  m.DM_GODANG AS master_godang,
  m.DM_DAREGNO AS master_dare_registration_no,
  m.DM_WARRINGMEMO AS master_warning_memo
FROM dbo.prsdrug d WITH (NOLOCK)
LEFT JOIN eP_BASES.dbo.dgmast m WITH (NOLOCK)
  ON m.dm_iscode = d.pd_iscode
WHERE d.pd_code = $prescriptionLiteral
ORDER BY d.pd_no
"@
[void](Export-QueryResult -Manifest $manifest -Kind "prsdrug-joined" -Database "eP_PHARM" -SchemaName "dbo" -TableName "prsdrug" -Query $joinedQuery -FileName "prsdrug.joined-dgmast.csv" -TimeoutSeconds 15)

if ($insuranceValues.Count -gt 0) {
  [void](Export-QueryResult -Manifest $manifest -Kind "dgmast-target-codes" -Database "eP_BASES" -SchemaName "dbo" -TableName "dgmast" -Query "SELECT * FROM dbo.dgmast WITH (NOLOCK) WHERE dm_iscode IN ($insuranceList) OR dm_drugcode IN ($insuranceList) ORDER BY dm_iscode" -FileName "dgmast.target-codes.csv" -TimeoutSeconds 15)
  [void](Export-QueryResult -Manifest $manifest -Kind "dgtrans-target-codes" -Database "eP_BASES" -SchemaName "dbo" -TableName "dgtrans" -Query "SELECT TOP ($MaxRowsPerTable) * FROM dbo.dgtrans WITH (NOLOCK) WHERE dt_iscode IN ($insuranceList) ORDER BY dt_duedate DESC" -FileName "dgtrans.target-codes.csv" -TimeoutSeconds 15)
  [void](Export-QueryResult -Manifest $manifest -Kind "dgunit-target-codes" -Database "eP_BASES" -SchemaName "dbo" -TableName "dgunit" -Query "SELECT TOP ($MaxRowsPerTable) * FROM dbo.dgunit WITH (NOLOCK) WHERE du_iscode IN ($insuranceList) ORDER BY du_iscode, du_no" -FileName "dgunit.target-codes.csv" -TimeoutSeconds 15)
}

$databases = @()
try {
  $databases = Get-TargetDatabases
} catch {
  Write-Log "database list failed $($_.Exception.Message)"
}

foreach ($database in $databases) {
  try {
    $columnRows = Get-CandidateColumns -Database $database
    foreach ($row in $columnRows.Rows) {
      $allColumns.Add([pscustomobject]@{
        database = $database
        schema = (Get-DataRowValue $row "schemaName").ToString()
        table = (Get-DataRowValue $row "tableName").ToString()
        columnId = Get-DataRowValue $row "columnId"
        columnName = (Get-DataRowValue $row "columnName").ToString()
        typeName = (Get-DataRowValue $row "typeName").ToString()
        maxLength = Get-DataRowValue $row "maxLength"
        isNullable = Get-DataRowValue $row "isNullable"
        maskedInExports = if ((Get-DataRowValue $row "columnName").ToString() -match $SensitiveColumnPattern) { "true" } else { "false" }
      })
    }

    $searchable = Get-SearchableColumns -Database $database
    $searchRows = New-Object System.Collections.Generic.List[object]
    foreach ($row in $searchable.Rows) {
      $searchRows.Add([pscustomobject]@{
        schemaName = (Get-DataRowValue $row "schemaName").ToString()
        tableName = (Get-DataRowValue $row "tableName").ToString()
        columnName = (Get-DataRowValue $row "columnName").ToString()
        typeName = (Get-DataRowValue $row "typeName").ToString()
      })
    }

    Export-ValueMatches -Manifest $manifest -Kind "prescription-code-hit" -Database $database -ColumnRows $searchRows.ToArray() -Values @($PrescriptionCode)

    if ($insuranceValues.Count -gt 0) {
      Export-ValueMatches -Manifest $manifest -Kind "insurance-code-hit" -Database $database -ColumnRows $searchRows.ToArray() -Values $insuranceValues
    }
  } catch {
    Add-ManifestRow -Manifest $manifest -Kind "database-scan" -Database $database -SchemaName "" -TableName "" -Status "DATABASE_FAILED" -Rows 0 -File "" -Error $_.Exception.Message
  }
}

$allColumns | Export-Csv -LiteralPath $ColumnPath -NoTypeInformation -Encoding UTF8
$manifest | Export-Csv -LiteralPath $ManifestPath -NoTypeInformation -Encoding UTF8

$exported = @($manifest | Where-Object { $_.status -eq "EXPORTED" })
$nonEmpty = @($exported | Where-Object { $_.rows -gt 0 })
$empty = @($exported | Where-Object { $_.rows -eq 0 })
$failed = @($manifest | Where-Object { $_.status -ne "EXPORTED" })

Set-Content -LiteralPath $SummaryPath -Encoding UTF8 -Value @(
  "PharmFarm prescription trace export",
  "CreatedAt=$(Get-Date -Format o)",
  "Server=$Server",
  "PrescriptionCode=$PrescriptionCode",
  "InsuranceCode=$($insuranceValues -join ',')",
  "DatabaseCount=$($databases.Count)",
  "ExportedFileCount=$($exported.Count)",
  "NonEmptyFileCount=$($nonEmpty.Count)",
  "EmptyFileCount=$($empty.Count)",
  "FailedQueryCount=$($failed.Count)",
  "Output=$ExportRoot",
  "",
  "Primary files to inspect first:",
  "1. eP_PHARM\prsdrug.raw.csv",
  "2. eP_PHARM\prsdrug.joined-dgmast.csv",
  "3. eP_ERROR_LOG\prescription-edb.PRESCRIPT_EDB.csv",
  "4. eP_BASES\dgmast.target-codes.csv",
  "5. candidate_columns.csv",
  "",
  "Look for columns that connect original and substitute lines, such as org/ori/sub/chg/cnv fields, or a separate table hit with both the prescription code and target insurance codes.",
  "Sensitive-looking columns are masked by column name pattern in CSV files.",
  "WARNING: Files may still include prescription or pharmacy business data.",
  "Do not upload/share the folder unless legally approved."
)

$codexLines = New-Object System.Collections.Generic.List[string]
$codexLines.Add("PharmFarm prescription trace summary")
$codexLines.Add("CreatedAt=" + (Get-Date -Format o))
$codexLines.Add("Server=" + $Server)
$codexLines.Add("PrescriptionCode=" + $PrescriptionCode)
$codexLines.Add("InsuranceCode=" + ($insuranceValues -join ","))
$codexLines.Add("Output=" + $ExportRoot)
$codexLines.Add("")
$codexLines.Add("HOW TO SHARE")
$codexLines.Add("1. Send this SEND_TO_CODEX.txt first.")
$codexLines.Add("2. If asked, send manifest.csv and candidate_columns.csv.")
$codexLines.Add("3. For this specific issue, prsdrug.raw.csv and prsdrug.joined-dgmast.csv are usually the most important files.")
$codexLines.Add("")
$codexLines.Add("NON-EMPTY EXPORTS")
foreach ($item in $nonEmpty) {
  $codexLines.Add(("{0} {1}.{2}.{3} rows={4} file={5}" -f $item.kind, $item.database, $item.schema, $item.table, $item.rows, $item.file))
}
$codexLines.Add("")
$codexLines.Add("FAILED QUERIES")
foreach ($item in $failed) {
  $codexLines.Add(("{0} {1}.{2}.{3} error={4}" -f $item.kind, $item.database, $item.schema, $item.table, $item.error))
}
$codexLines.Add("")
$codexLines.Add("CANDIDATE COLUMNS WITH RELATION HINTS")
$hintColumns = @($allColumns | Where-Object {
  $_.columnName -match '(sub|org|ori|chg|cnv|replace|alter|origin|parent|link|group|code|iscode)'
} | Select-Object -First 400)
foreach ($col in $hintColumns) {
  $codexLines.Add(("{0}.{1}.{2}.{3} type={4} masked={5}" -f $col.database, $col.schema, $col.table, $col.columnName, $col.typeName, $col.maskedInExports))
}

Set-Content -LiteralPath $CodexPath -Encoding UTF8 -Value $codexLines

Write-Log "done nonEmptyFiles=$($nonEmpty.Count) failedQueries=$($failed.Count)"
Write-Log "manifest=$ManifestPath"
Write-Log "summary=$SummaryPath"
Write-Log "codex=$CodexPath"
Write-Host ""
Write-Host "Open this folder: $ExportRoot"
