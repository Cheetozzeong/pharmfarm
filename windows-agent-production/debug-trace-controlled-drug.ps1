param(
  [string]$Server = ".\EPHARM_DB",
  [string]$InsuranceCode = "",
  [string]$DrugName = "",
  [int]$MaxRows = 50,
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

$AppName = "PharmFarmAgent"
$BaseRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
  $PSScriptRoot
} else {
  Join-Path $env:ProgramData $AppName
}

$ExportRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  Join-Path $BaseRoot ("debug-export\controlled-trace-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
} else {
  $OutputRoot
}

function Ensure-Directory {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) {
    [void](New-Item -ItemType Directory -Force -Path $Path)
  }
}

function New-ConnectionString {
  param(
    [string]$SqlServer,
    [string]$DbName
  )

  return "Server=$SqlServer;Database=$DbName;Integrated Security=True;Connection Timeout=6;Application Name=PharmFarmControlledTrace;"
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

function Quote-SqlLiteral {
  param([string]$Value)
  return "N'" + $Value.Replace("'", "''") + "'"
}

function New-MatchWhereClause {
  param(
    [string[]]$CodeColumns,
    [string[]]$NameColumns
  )

  $conditions = New-Object System.Collections.Generic.List[string]
  $code = $InsuranceCode.Trim()
  $name = $DrugName.Trim()

  if (![string]::IsNullOrWhiteSpace($code)) {
    $codeLiteral = Quote-SqlLiteral $code
    foreach ($column in $CodeColumns) {
      $conditions.Add("LTRIM(RTRIM(CONVERT(NVARCHAR(120), $column))) = $codeLiteral")
    }
  }

  if (![string]::IsNullOrWhiteSpace($name)) {
    $nameLiteral = Quote-SqlLiteral ("%" + $name + "%")
    foreach ($column in $NameColumns) {
      $conditions.Add("CONVERT(NVARCHAR(500), $column) LIKE $nameLiteral")
    }
  }

  if ($conditions.Count -eq 0) {
    return "1=0"
  }

  return "(" + ($conditions.ToArray() -join " OR ") + ")"
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

function Convert-DataTableRows {
  param([System.Data.DataTable]$Table)

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

    [pscustomobject]$item
  }
}

function Export-DataTableCsv {
  param(
    [System.Data.DataTable]$Table,
    [string]$Path
  )

  if ($Table.Rows.Count -eq 0) {
    $header = ($Table.Columns | ForEach-Object { $_.ColumnName }) -join ","
    Set-Content -LiteralPath $Path -Value $header -Encoding UTF8
    return
  }

  Convert-DataTableRows $Table | Export-Csv -LiteralPath $Path -NoTypeInformation -Encoding UTF8
}

if ([string]::IsNullOrWhiteSpace($InsuranceCode) -and [string]::IsNullOrWhiteSpace($DrugName)) {
  throw "Provide -InsuranceCode or -DrugName."
}

$max = [Math]::Max(1, [Math]::Min($MaxRows, 500))
Ensure-Directory $ExportRoot

$habitWhere = New-MatchWhereClause -CodeColumns @("hd_iscode") -NameColumns @("hd_shname", "hd_remark")
$dgmastWhere = New-MatchWhereClause -CodeColumns @("dm_iscode", "dm_drugcode") -NameColumns @("dm_drugname", "DM_WARRINGMEMO")
$priceWhere = New-MatchWhereClause -CodeColumns @("dt_iscode") -NameColumns @()

$habitQuery = @"
SELECT TOP ($max)
  CONVERT(NVARCHAR(80), hd_iscode) AS insuranceCode,
  CONVERT(NVARCHAR(40), hd_group) AS habitGroup,
  CONVERT(NVARCHAR(40), hd_no) AS habitNo,
  CONVERT(NVARCHAR(300), hd_shname) AS shortName,
  CONVERT(NVARCHAR(500), hd_remark) AS remark,
  CONVERT(NVARCHAR(40), hd_date) AS appliedDate,
  CONVERT(NVARCHAR(300), hd_locate) AS locate,
  CONVERT(NVARCHAR(120), hd_button) AS button,
  CONVERT(NVARCHAR(40), hd_subindex) AS subIndex,
  CONVERT(NVARCHAR(40), hd_kind) AS habitKind,
  CONVERT(NVARCHAR(80), hd_goupPirce) AS groupPrice,
  CONVERT(NVARCHAR(40), hd_unitNo) AS unitNo,
  CONVERT(NVARCHAR(40), HD_STORE) AS storeCode,
  CASE WHEN hd_iscode IS NOT NULL THEN 'true' ELSE 'false' END AS agentDirectControlled
FROM dbo.habitdrug WITH (NOLOCK)
WHERE $habitWhere
ORDER BY hd_iscode, hd_group, hd_no, hd_kind
"@

$dgmastQuery = @"
SELECT TOP ($max)
  CONVERT(NVARCHAR(80), dm_iscode) AS insuranceCode,
  CONVERT(NVARCHAR(300), dm_drugname) AS drugName,
  CONVERT(NVARCHAR(80), dm_stockno) AS stockNo,
  CONVERT(NVARCHAR(80), dm_drugcode) AS drugCode,
  CONVERT(NVARCHAR(120), dm_StockViewUnit) AS stockViewUnit,
  CONVERT(NVARCHAR(80), dm_StockViewQty) AS stockViewQty,
  CONVERT(NVARCHAR(40), dm_extype) AS exceptionType,
  CONVERT(NVARCHAR(500), DM_WARRINGMEMO) AS warningMemo,
  CONVERT(NVARCHAR(80), DM_DAREGNO) AS dareRegistrationNo,
  CONVERT(NVARCHAR(40), DM_GODANG) AS godangCode,
  CONVERT(NVARCHAR(40), dm_applydate) AS appliedDate,
  CASE
    WHEN NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(80), DM_DAREGNO))), '') IS NOT NULL THEN 'true'
    WHEN NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(40), DM_GODANG))), '') IS NOT NULL THEN 'true'
    WHEN NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(500), DM_WARRINGMEMO))), '') IS NOT NULL THEN 'true'
    WHEN ISNULL(CONVERT(NVARCHAR(40), dm_extype), '') <> '' AND CONVERT(NVARCHAR(40), dm_extype) <> '0' THEN 'true'
    ELSE 'false'
  END AS agentControlledCandidate,
  LTRIM(RTRIM(
    CASE WHEN NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(80), DM_DAREGNO))), '') IS NOT NULL THEN 'DM_DAREGNO ' ELSE '' END +
    CASE WHEN NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(40), DM_GODANG))), '') IS NOT NULL THEN 'DM_GODANG ' ELSE '' END +
    CASE WHEN NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(500), DM_WARRINGMEMO))), '') IS NOT NULL THEN 'DM_WARRINGMEMO ' ELSE '' END +
    CASE WHEN ISNULL(CONVERT(NVARCHAR(40), dm_extype), '') <> '' AND CONVERT(NVARCHAR(40), dm_extype) <> '0' THEN 'dm_extype ' ELSE '' END
  )) AS agentControlledCandidateSource
FROM dbo.dgmast WITH (NOLOCK)
WHERE $dgmastWhere
ORDER BY dm_iscode, dm_drugname
"@

$priceQuery = @"
SELECT TOP ($max)
  CONVERT(NVARCHAR(80), dt_iscode) AS insuranceCode,
  CONVERT(NVARCHAR(40), dt_duedate) AS dueDate,
  CONVERT(NVARCHAR(40), dt_expdate) AS expireDate,
  CONVERT(NVARCHAR(80), dt_price) AS price,
  CONVERT(NVARCHAR(80), dt_sellprice) AS sellPrice,
  CONVERT(NVARCHAR(80), dt_addprice) AS addPrice,
  CONVERT(NVARCHAR(40), dt_chgdate) AS changedDate,
  CONVERT(NVARCHAR(40), dt_extype) AS exceptionType,
  CONVERT(NVARCHAR(20), DT_INSUPAY_30) AS insurancePay30,
  CONVERT(NVARCHAR(20), DT_INSUPAY_50) AS insurancePay50,
  CONVERT(NVARCHAR(20), DT_INSUPAY_80) AS insurancePay80
FROM dbo.dgtrans WITH (NOLOCK)
WHERE $priceWhere
ORDER BY dt_iscode, dt_duedate DESC, dt_chgdate DESC
"@

Write-Host "Tracing controlled-drug source columns..."
Write-Host ("Server: {0}" -f $Server)
Write-Host ("Output: {0}" -f $ExportRoot)

$habitRows = Invoke-SqlQuery -SqlServer $Server -DbName "eP_BASES" -Query $habitQuery -TimeoutSeconds 30
$dgmastRows = Invoke-SqlQuery -SqlServer $Server -DbName "eP_BASES" -Query $dgmastQuery -TimeoutSeconds 30
$priceRows = Invoke-SqlQuery -SqlServer $Server -DbName "eP_BASES" -Query $priceQuery -TimeoutSeconds 30

Export-DataTableCsv -Table $habitRows -Path (Join-Path $ExportRoot "habitdrug_match.csv")
Export-DataTableCsv -Table $dgmastRows -Path (Join-Path $ExportRoot "dgmast_match.csv")
Export-DataTableCsv -Table $priceRows -Path (Join-Path $ExportRoot "dgtrans_price_match.csv")

$summary = @(
  "PharmFarm controlled-drug trace",
  "capturedAt=$(Get-Date -Format o)",
  "server=$Server",
  "insuranceCode=$InsuranceCode",
  "drugName=$DrugName",
  "maxRows=$max",
  "",
  "rows.habitdrug=$($habitRows.Rows.Count)",
  "rows.dgmast=$($dgmastRows.Rows.Count)",
  "rows.dgtrans=$($priceRows.Rows.Count)",
  "",
  "Current agent criteria:",
  "- Direct controlled source: eP_BASES.dbo.habitdrug where hd_iscode is not null.",
  "- Master candidate source: eP_BASES.dbo.dgmast where dm_iscode is not null and one or more of DM_DAREGNO, DM_GODANG, DM_WARRINGMEMO is non-empty, or dm_extype is non-empty and not 0.",
  "- dgtrans is exported for context only; current controlled-drug candidate logic does not use dgtrans.",
  "",
  "Files:",
  "- habitdrug_match.csv",
  "- dgmast_match.csv",
  "- dgtrans_price_match.csv"
)

Set-Content -LiteralPath (Join-Path $ExportRoot "summary.txt") -Value $summary -Encoding UTF8

Write-Host "Done."
Write-Host ("habitdrug rows: {0}" -f $habitRows.Rows.Count)
Write-Host ("dgmast rows: {0}" -f $dgmastRows.Rows.Count)
Write-Host ("dgtrans rows: {0}" -f $priceRows.Rows.Count)
