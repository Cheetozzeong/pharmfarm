param(
  [string]$Server = ".\EPHARM_DB",
  [string]$InsuranceCode = "",
  [string]$DrugName = "",
  [int]$MaxRows = 0,
  [string]$ReferenceCsv = "",
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

$AppName = "PharmFarmAgent"
$BaseRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
  $PSScriptRoot
} else {
  Join-Path $env:ProgramData $AppName
}

$DefaultReferenceCsv = Join-Path $PSScriptRoot "controlled-drug-reference.csv"
$ResolvedReferenceCsv = if ([string]::IsNullOrWhiteSpace($ReferenceCsv)) {
  $DefaultReferenceCsv
} else {
  $ReferenceCsv
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

function Convert-Text {
  param($Value)

  if ($null -eq $Value -or $Value -is [DBNull]) {
    return ""
  }

  return $Value.ToString().Trim()
}

function Get-ObjectValue {
  param(
    [object]$Object,
    [string[]]$Names
  )

  foreach ($name in $Names) {
    if ($null -ne $Object.PSObject.Properties[$name]) {
      return Convert-Text $Object.$name
    }
  }

  return ""
}

function Get-ReferenceRows {
  $rows = New-Object System.Collections.Generic.List[object]

  if (![string]::IsNullOrWhiteSpace($InsuranceCode) -or ![string]::IsNullOrWhiteSpace($DrugName)) {
    [void]$rows.Add([pscustomobject][ordered]@{
      page = ""
      pageRow = ""
      drugName = $DrugName.Trim()
      company = ""
      drugCode = $InsuranceCode.Trim()
      formPay = ""
      classEffect = ""
      kind = ""
      substituteEtc = ""
      componentCode = ""
      source = "manual"
    })
    return $rows.ToArray()
  }

  if (!(Test-Path -LiteralPath $ResolvedReferenceCsv)) {
    throw "Provide -InsuranceCode/-DrugName, or place the PDF-derived reference CSV at: $ResolvedReferenceCsv"
  }

  $csvRows = @(Get-Content -LiteralPath $ResolvedReferenceCsv -Encoding UTF8 | ConvertFrom-Csv)

  foreach ($row in $csvRows) {
    $code = Get-ObjectValue $row @("drugCode", "insuranceCode", "code", "약품코드")
    if ([string]::IsNullOrWhiteSpace($code)) {
      continue
    }

    [void]$rows.Add([pscustomobject][ordered]@{
      page = Get-ObjectValue $row @("page")
      pageRow = Get-ObjectValue $row @("pageRow")
      drugName = Get-ObjectValue $row @("drugName", "약품명")
      company = Get-ObjectValue $row @("company", "제약회사")
      drugCode = $code
      formPay = Get-ObjectValue $row @("formPay", "형태")
      classEffect = Get-ObjectValue $row @("classEffect", "분류")
      kind = Get-ObjectValue $row @("kind", "구분")
      substituteEtc = Get-ObjectValue $row @("substituteEtc")
      componentCode = Get-ObjectValue $row @("componentCode", "성분코드")
      source = "pdf-reference"
    })
  }

  if ($rows.Count -eq 0) {
    throw "Reference CSV has no rows with a drugCode/insuranceCode/code column: $ResolvedReferenceCsv"
  }

  return $rows.ToArray()
}

function Get-ReferenceCodes {
  param(
    [object[]]$Rows,
    [bool]$IncludeComponentCode = $false
  )

  $seen = @{}
  $codes = New-Object System.Collections.Generic.List[string]

  foreach ($row in $Rows) {
    $rowCodes = New-Object System.Collections.Generic.List[string]
    [void]$rowCodes.Add((Convert-Text $row.drugCode))

    if ($IncludeComponentCode) {
      [void]$rowCodes.Add((Convert-Text $row.componentCode))
    }

    foreach ($code in $rowCodes) {
      if ([string]::IsNullOrWhiteSpace($code) -or $seen.ContainsKey($code)) {
        continue
      }

      $seen[$code] = $true
      [void]$codes.Add($code)
    }
  }

  return $codes.ToArray()
}

function New-CodeWhereClause {
  param(
    [string[]]$CodeColumns,
    [string[]]$Codes
  )

  if ($Codes.Count -eq 0) {
    return "1=0"
  }

  $literals = ($Codes | ForEach-Object { Quote-SqlLiteral $_ }) -join ","
  $conditions = foreach ($column in $CodeColumns) {
    "LTRIM(RTRIM(CONVERT(NVARCHAR(120), $column))) IN ($literals)"
  }

  return "(" + ($conditions -join " OR ") + ")"
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
      [void]$conditions.Add("LTRIM(RTRIM(CONVERT(NVARCHAR(120), $column))) = $codeLiteral")
    }
  }

  if (![string]::IsNullOrWhiteSpace($name)) {
    $nameLiteral = Quote-SqlLiteral ("%" + $name + "%")
    foreach ($column in $NameColumns) {
      [void]$conditions.Add("CONVERT(NVARCHAR(500), $column) LIKE $nameLiteral")
    }
  }

  if ($conditions.Count -eq 0) {
    return "1=0"
  }

  return "(" + ($conditions.ToArray() -join " OR ") + ")"
}

function New-TraceWhereClause {
  param(
    [string[]]$CodeColumns,
    [string[]]$NameColumns,
    [string[]]$Codes
  )

  if ($Codes.Count -gt 0) {
    return New-CodeWhereClause -CodeColumns $CodeColumns -Codes $Codes
  }

  return New-MatchWhereClause -CodeColumns $CodeColumns -NameColumns $NameColumns
}

function New-TopClause {
  param([int]$Limit)

  if ($Limit -le 0) {
    return ""
  }

  return "TOP ($Limit)"
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

function Add-MapItem {
  param(
    [hashtable]$Map,
    [string]$Key,
    [object]$Value
  )

  $normalizedKey = Convert-Text $Key
  if ([string]::IsNullOrWhiteSpace($normalizedKey)) {
    return
  }

  if (!$Map.ContainsKey($normalizedKey)) {
    $Map[$normalizedKey] = New-Object System.Collections.ArrayList
  }

  [void]$Map[$normalizedKey].Add($Value)
}

function New-RowMap {
  param(
    [System.Data.DataTable]$Table,
    [string[]]$ColumnNames
  )

  $map = @{}

  foreach ($row in $Table.Rows) {
    $seen = @{}
    foreach ($columnName in $ColumnNames) {
      $value = Convert-Text (Get-DataRowValue $row $columnName)
      if ([string]::IsNullOrWhiteSpace($value) -or $seen.ContainsKey($value)) {
        continue
      }

      $seen[$value] = $true
      Add-MapItem -Map $map -Key $value -Value $row
    }
  }

  return $map
}

function Get-MapRows {
  param(
    [hashtable]$Map,
    [string]$Key
  )

  $normalizedKey = Convert-Text $Key
  if ([string]::IsNullOrWhiteSpace($normalizedKey) -or !$Map.ContainsKey($normalizedKey)) {
    return @()
  }

  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($row in $Map[$normalizedKey]) {
    [void]$rows.Add($row)
  }

  return $rows.ToArray()
}

function Get-MergedMapRows {
  param(
    [hashtable]$Map,
    [string[]]$Keys
  )

  $seen = @{}
  $rows = New-Object System.Collections.Generic.List[object]

  foreach ($key in $Keys) {
    foreach ($row in @(Get-MapRows -Map $Map -Key $key)) {
      $identity = [System.Runtime.CompilerServices.RuntimeHelpers]::GetHashCode($row).ToString()
      if ($seen.ContainsKey($identity)) {
        continue
      }

      $seen[$identity] = $true
      [void]$rows.Add($row)
    }
  }

  return $rows.ToArray()
}

function Join-UniqueColumnValues {
  param(
    [object[]]$Rows,
    [string]$ColumnName
  )

  $seen = @{}
  $values = New-Object System.Collections.Generic.List[string]

  foreach ($row in $Rows) {
    $value = Convert-Text (Get-DataRowValue $row $ColumnName)
    if ([string]::IsNullOrWhiteSpace($value) -or $seen.ContainsKey($value)) {
      continue
    }

    $seen[$value] = $true
    [void]$values.Add($value)
  }

  return ($values.ToArray() -join " | ")
}

function New-ReferenceMatchSummary {
  param(
    [object[]]$ReferenceRows,
    [System.Data.DataTable]$HabitRows,
    [System.Data.DataTable]$DgmastRows
  )

  $habitMap = New-RowMap -Table $HabitRows -ColumnNames @("insuranceCode")
  $dgmastMap = New-RowMap -Table $DgmastRows -ColumnNames @("insuranceCode", "drugCode")

  foreach ($reference in $ReferenceRows) {
    $code = Convert-Text $reference.drugCode
    if ([string]::IsNullOrWhiteSpace($code)) {
      continue
    }

    $habitMatches = @(Get-MapRows -Map $habitMap -Key $code)
    $componentCode = Convert-Text $reference.componentCode
    $dgmastMatches = @(Get-MergedMapRows -Map $dgmastMap -Keys @($code, $componentCode))
    $candidateMatches = @($dgmastMatches | Where-Object { (Convert-Text (Get-DataRowValue $_ "agentControlledCandidate")) -eq "true" })

    [pscustomobject][ordered]@{
      referenceDrugCode = $code
      referenceDrugName = Convert-Text $reference.drugName
      referenceCompany = Convert-Text $reference.company
      referenceComponentCode = Convert-Text $reference.componentCode
      referencePage = Convert-Text $reference.page
      referencePageRow = Convert-Text $reference.pageRow
      habitdrugMatched = ($habitMatches.Count -gt 0)
      habitdrugMatchCount = $habitMatches.Count
      dgmastMatched = ($dgmastMatches.Count -gt 0)
      dgmastMatchCount = $dgmastMatches.Count
      dgmastControlledCandidate = ($candidateMatches.Count -gt 0)
      dgmastCandidateSource = Join-UniqueColumnValues -Rows $candidateMatches -ColumnName "agentControlledCandidateSource"
      dgmastDrugNames = Join-UniqueColumnValues -Rows $dgmastMatches -ColumnName "drugName"
      matchedAny = (($habitMatches.Count -gt 0) -or ($dgmastMatches.Count -gt 0))
    }
  }
}

if ($MaxRows -lt 0) {
  throw "-MaxRows must be 0 or greater. Use 0 to export all matches."
}

$referenceRows = @(Get-ReferenceRows)
$referenceCodes = @(Get-ReferenceCodes -Rows $referenceRows)
$dgmastLookupCodes = @(Get-ReferenceCodes -Rows $referenceRows -IncludeComponentCode $true)
$topClause = New-TopClause -Limit $MaxRows

Ensure-Directory $ExportRoot

$habitWhere = New-TraceWhereClause -CodeColumns @("hd_iscode") -NameColumns @("hd_shname", "hd_remark") -Codes $referenceCodes
$dgmastWhere = New-TraceWhereClause -CodeColumns @("dm_iscode", "dm_drugcode") -NameColumns @("dm_drugname", "DM_WARRINGMEMO") -Codes $dgmastLookupCodes
$priceWhere = New-TraceWhereClause -CodeColumns @("dt_iscode") -NameColumns @() -Codes $referenceCodes

$habitQuery = @"
SELECT $topClause
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
SELECT $topClause
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
  'true' AS agentControlledCandidate,
  LTRIM(RTRIM(
    N'PDF_REFERENCE ' +
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
SELECT $topClause
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
Write-Host ("Reference rows: {0}" -f $referenceRows.Count)
if ((Test-Path -LiteralPath $ResolvedReferenceCsv) -and [string]::IsNullOrWhiteSpace($InsuranceCode) -and [string]::IsNullOrWhiteSpace($DrugName)) {
  Write-Host ("Reference CSV: {0}" -f $ResolvedReferenceCsv)
  Copy-Item -LiteralPath $ResolvedReferenceCsv -Destination (Join-Path $ExportRoot "pdf_reference.csv") -Force
}

$habitRows = Invoke-SqlQuery -SqlServer $Server -DbName "eP_BASES" -Query $habitQuery -TimeoutSeconds 60
$dgmastRows = Invoke-SqlQuery -SqlServer $Server -DbName "eP_BASES" -Query $dgmastQuery -TimeoutSeconds 60
$priceRows = Invoke-SqlQuery -SqlServer $Server -DbName "eP_BASES" -Query $priceQuery -TimeoutSeconds 60

Export-DataTableCsv -Table $habitRows -Path (Join-Path $ExportRoot "habitdrug_match.csv")
Export-DataTableCsv -Table $dgmastRows -Path (Join-Path $ExportRoot "dgmast_match.csv")
Export-DataTableCsv -Table $priceRows -Path (Join-Path $ExportRoot "dgtrans_price_match.csv")

$referenceMatchSummary = @(New-ReferenceMatchSummary -ReferenceRows $referenceRows -HabitRows $habitRows -DgmastRows $dgmastRows)
$referenceSummaryPath = Join-Path $ExportRoot "reference_match_summary.csv"
$referenceMatchSummary | Export-Csv -LiteralPath $referenceSummaryPath -NoTypeInformation -Encoding UTF8

$matchedAnyCount = @($referenceMatchSummary | Where-Object { $_.matchedAny -eq $true }).Count
$habitMatchedCount = @($referenceMatchSummary | Where-Object { $_.habitdrugMatched -eq $true }).Count
$dgmastMatchedCount = @($referenceMatchSummary | Where-Object { $_.dgmastMatched -eq $true }).Count
$candidateCount = @($referenceMatchSummary | Where-Object { $_.dgmastControlledCandidate -eq $true }).Count

$summary = @(
  "PharmFarm controlled-drug trace",
  "capturedAt=$(Get-Date -Format o)",
  "server=$Server",
  "insuranceCode=$InsuranceCode",
  "drugName=$DrugName",
  "referenceCsv=$ResolvedReferenceCsv",
  "referenceRows=$($referenceRows.Count)",
  "referenceCodes=$($referenceCodes.Count)",
  "referenceDgmastLookupCodes=$($dgmastLookupCodes.Count)",
  "maxRows=$(if ($MaxRows -le 0) { 'all' } else { $MaxRows })",
  "",
  "rows.habitdrug=$($habitRows.Rows.Count)",
  "rows.dgmast=$($dgmastRows.Rows.Count)",
  "rows.dgtrans=$($priceRows.Rows.Count)",
  "reference.matchedAny=$matchedAnyCount",
  "reference.habitdrugMatched=$habitMatchedCount",
  "reference.dgmastMatched=$dgmastMatchedCount",
  "reference.dgmastControlledCandidate=$candidateCount",
  "",
  "Current agent criteria:",
  "- Primary source: controlled-drug-reference.csv extracted from 약품기본정보.pdf.",
  "- Direct source match: eP_BASES.dbo.habitdrug where hd_iscode/HD_STORE matches PDF drugCode.",
  "- Master source match: eP_BASES.dbo.dgmast where dm_iscode/dm_drugcode matches PDF drugCode or componentCode.",
  "- DM_DAREGNO, DM_GODANG, DM_WARRINGMEMO, and dm_extype are exported as DB evidence only; they are not the primary inclusion rule.",
  "- dgtrans is exported for context only; current controlled-drug candidate logic does not use dgtrans.",
  "",
  "Files:",
  "- pdf_reference.csv",
  "- reference_match_summary.csv",
  "- habitdrug_match.csv",
  "- dgmast_match.csv",
  "- dgtrans_price_match.csv"
)

Set-Content -LiteralPath (Join-Path $ExportRoot "summary.txt") -Value $summary -Encoding UTF8

Write-Host "Done."
Write-Host ("habitdrug rows: {0}" -f $habitRows.Rows.Count)
Write-Host ("dgmast rows: {0}" -f $dgmastRows.Rows.Count)
Write-Host ("dgtrans rows: {0}" -f $priceRows.Rows.Count)
Write-Host ("reference matched: {0}/{1}" -f $matchedAnyCount, $referenceMatchSummary.Count)
