$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppName = "PharmFarmAgent"
$TaskName = "PharmFarmAgent"
$TrayTaskName = "PharmFarmAgentTray"
$InstallRoot = Join-Path $env:ProgramData $AppName
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentSource = Join-Path $SourceRoot "PharmFarm-Agent.ps1"
$AgentTarget = Join-Path $InstallRoot "PharmFarm-Agent.ps1"
$TraySource = Join-Path $SourceRoot "PharmFarm-AgentTray.ps1"
$TrayTarget = Join-Path $InstallRoot "PharmFarm-AgentTray.ps1"
$ConfigTarget = Join-Path $InstallRoot "agent.config.json"

function Ensure-Directory {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) {
    [void](New-Item -ItemType Directory -Force -Path $Path)
  }
}

function New-Label {
  param(
    [string]$Text,
    [int]$X,
    [int]$Y,
    [int]$Width = 420,
    [int]$Height = 22,
    [bool]$Bold = $false
  )

  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Location = New-Object System.Drawing.Point($X, $Y)
  $label.Size = New-Object System.Drawing.Size($Width, $Height)
  $label.ForeColor = [System.Drawing.Color]::FromArgb(32, 35, 29)

  if ($Bold) {
    $label.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
  } else {
    $label.Font = New-Object System.Drawing.Font("Segoe UI", 9)
  }

  return $label
}

function New-TextBox {
  param(
    [string]$Text,
    [int]$X,
    [int]$Y,
    [int]$Width = 420
  )

  $box = New-Object System.Windows.Forms.TextBox
  $box.Text = $Text
  $box.Location = New-Object System.Drawing.Point($X, $Y)
  $box.Size = New-Object System.Drawing.Size($Width, 28)
  $box.Font = New-Object System.Drawing.Font("Segoe UI", 10)
  return $box
}

function New-CheckBox {
  param(
    [string]$Text,
    [int]$X,
    [int]$Y,
    [int]$Width = 250,
    [bool]$Checked = $false,
    [System.Drawing.Color]$ForeColor = [System.Drawing.Color]::FromArgb(104, 112, 97)
  )

  $check = New-Object System.Windows.Forms.CheckBox
  $check.Text = $Text
  $check.Location = New-Object System.Drawing.Point($X, $Y)
  $check.Size = New-Object System.Drawing.Size($Width, 24)
  $check.Font = New-Object System.Drawing.Font("Segoe UI", 9)
  $check.ForeColor = $ForeColor
  $check.Checked = $Checked
  return $check
}

function Write-Config {
  param(
    [string]$ApiBase,
    [string]$PharmacyId,
    [string]$SqlServer,
    [string]$DeviceName,
    [string]$AgentSecret,
    [bool]$IncludeRawQrText,
    [bool]$BootstrapDrugMaster,
    [bool]$BootstrapStock,
    [bool]$BootstrapBarcode,
    [bool]$BootstrapWholesaler,
    [bool]$BootstrapPurchase,
    [bool]$BootstrapControlledDrug,
    [bool]$BootstrapDrugPrice,
    [bool]$BootstrapDrugUnit,
    [int]$IntervalSeconds
  )

  Ensure-Directory $InstallRoot
  Copy-Item -LiteralPath $AgentSource -Destination $AgentTarget -Force
  Copy-Item -LiteralPath $TraySource -Destination $TrayTarget -Force

  $deviceIdSeed = "{0}|{1}|{2}" -f $env:COMPUTERNAME, $env:USERNAME, $DeviceName
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $deviceHash = ""

  try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($deviceIdSeed))
    $deviceHash = (($hashBytes | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha.Dispose()
  }

  $config = [ordered]@{
    apiBase = $ApiBase.TrimEnd("/")
    pharmacyId = [int]$PharmacyId
    sqlServer = $SqlServer
    deviceName = $DeviceName
    deviceId = "win-" + $deviceHash
    agentSecret = $AgentSecret
    intervalSeconds = $IntervalSeconds
    includeRawQrText = $IncludeRawQrText
    bootstrapDrugMaster = $BootstrapDrugMaster
    bootstrapStock = $BootstrapStock
    bootstrapBarcode = $BootstrapBarcode
    bootstrapWholesaler = $BootstrapWholesaler
    bootstrapPurchase = $BootstrapPurchase
    bootstrapControlledDrug = $BootstrapControlledDrug
    bootstrapDrugPrice = $BootstrapDrugPrice
    bootstrapDrugUnit = $BootstrapDrugUnit
    bootstrapStockProbe = $false
    bootstrapChunkSize = 500
    deltaSyncOnStart = $true
    referenceSyncIntervalMinutes = 1440
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  $config.deviceId = $config.deviceId.Substring(0, [Math]::Min(48, $config.deviceId.Length))
  $json = $config | ConvertTo-Json -Depth 8
  Set-Content -LiteralPath $ConfigTarget -Value $json -Encoding UTF8
}

function Register-AgentTask {
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentTarget`""
  $trayArgument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$TrayTarget`""
  $action = New-ScheduledTaskAction -Execute $psExe -Argument $argument
  $trayAction = New-ScheduledTaskAction -Execute $psExe -Argument $trayArgument
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $traySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "PharmFarm Windows prescription collection agent" -Force | Out-Null
    Register-ScheduledTask -TaskName $TrayTaskName -Action $trayAction -Trigger $trigger -Settings $traySettings -Description "PharmFarm tray status icon" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-ScheduledTask -TaskName $TrayTaskName
    return $true
  } catch {
    [System.Windows.Forms.MessageBox]::Show("예약 작업 등록에 실패했습니다.`r`n$($_.Exception.Message)`r`n`r`n관리자 권한으로 다시 실행하거나 run-agent-console.bat으로 수동 실행하세요.", "PharmFarm Agent", "OK", "Warning") | Out-Null
    return $false
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "PharmFarm Agent Setup"
$form.Size = New-Object System.Drawing.Size(620, 840)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(245, 246, 239)

$title = New-Object System.Windows.Forms.Label
$title.Text = "PharmFarm Agent"
$title.Location = New-Object System.Drawing.Point(34, 28)
$title.Size = New-Object System.Drawing.Size(540, 42)
$title.Font = New-Object System.Drawing.Font("Segoe UI", 23, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(32, 35, 29)
$form.Controls.Add($title)

$subtitle = New-Label "Windows PC에서 처방 약품 데이터를 안전하게 수집하는 로컬 에이전트입니다." 38 74 540 26
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(104, 112, 97)
$form.Controls.Add($subtitle)

$card = New-Object System.Windows.Forms.Panel
$card.Location = New-Object System.Drawing.Point(34, 118)
$card.Size = New-Object System.Drawing.Size(540, 560)
$card.BackColor = [System.Drawing.Color]::White
$card.BorderStyle = "FixedSingle"
$form.Controls.Add($card)

$card.Controls.Add((New-Label "설치 설정" 22 18 460 24 $true))
$card.Controls.Add((New-Label "API 주소" 22 58 120 22 $true))
$apiBox = New-TextBox "https://api.solusi.co.kr/api/v1/pharmfarm" 22 82 492
$card.Controls.Add($apiBox)

$card.Controls.Add((New-Label "약국 ID" 22 122 120 22 $true))
$pharmacyIdBox = New-TextBox "" 22 146 120
$card.Controls.Add($pharmacyIdBox)
$pharmacyIdHelp = New-Label "CMS에 등록된 약국 번호를 입력하세요." 156 150 340 22
$pharmacyIdHelp.ForeColor = [System.Drawing.Color]::FromArgb(104, 112, 97)
$card.Controls.Add($pharmacyIdHelp)

$card.Controls.Add((New-Label "SQL Server" 22 186 120 22 $true))
$sqlBox = New-TextBox ".\EPHARM_DB" 22 210 492
$card.Controls.Add($sqlBox)

$card.Controls.Add((New-Label "기기 별칭" 22 250 120 22 $true))
$deviceBox = New-TextBox "$env:COMPUTERNAME" 22 274 492
$card.Controls.Add($deviceBox)

$card.Controls.Add((New-Label "Agent Secret 또는 설치 토큰" 22 314 220 22 $true))
$secretBox = New-TextBox "" 22 338 492
$secretBox.PasswordChar = "*"
$card.Controls.Add($secretBox)

$rawCheck = New-CheckBox "디버깅용 QR 원문 포함" 22 378 190 $false
$card.Controls.Add($rawCheck)

$intervalLabel = New-Label "조회 주기(초)" 242 314 92 22 $true
$intervalLabel.Location = New-Object System.Drawing.Point(242, 378)
$card.Controls.Add($intervalLabel)
$intervalBox = New-TextBox "10" 340 374 60
$card.Controls.Add($intervalBox)

$bootstrapReferenceAllCheck = New-CheckBox "설치 시 초기 데이터 전체 동기화" 22 414 270 $false
$card.Controls.Add($bootstrapReferenceAllCheck)

$toggleReferenceDetailButton = New-Object System.Windows.Forms.Button
$toggleReferenceDetailButton.Text = "펼치기"
$toggleReferenceDetailButton.Location = New-Object System.Drawing.Point(430, 410)
$toggleReferenceDetailButton.Size = New-Object System.Drawing.Size(84, 28)
$toggleReferenceDetailButton.FlatStyle = "Flat"
$toggleReferenceDetailButton.Font = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Bold)
$card.Controls.Add($toggleReferenceDetailButton)

$referenceDetailPanel = New-Object System.Windows.Forms.Panel
$referenceDetailPanel.Location = New-Object System.Drawing.Point(36, 444)
$referenceDetailPanel.Size = New-Object System.Drawing.Size(478, 78)
$referenceDetailPanel.Visible = $false
$card.Controls.Add($referenceDetailPanel)

$bootstrapDrugCheck = New-CheckBox "약품 마스터" 0 0 112 $false ([System.Drawing.Color]::FromArgb(32, 35, 29))
$bootstrapStockCheck = New-CheckBox "재고" 118 0 82 $false
$bootstrapBarcodeCheck = New-CheckBox "바코드" 206 0 88 $false
$bootstrapWholesalerCheck = New-CheckBox "도매처" 300 0 90 $false
$bootstrapControlledDrugCheck = New-CheckBox "향정 후보" 0 34 100 $false
$bootstrapDrugPriceCheck = New-CheckBox "가격" 106 34 72 $false
$bootstrapDrugUnitCheck = New-CheckBox "단위/포장" 184 34 104 $false
$bootstrapPurchaseCheck = New-CheckBox "매입내역" 294 34 100 $false

@(
  $bootstrapDrugCheck,
  $bootstrapStockCheck,
  $bootstrapBarcodeCheck,
  $bootstrapWholesalerCheck,
  $bootstrapControlledDrugCheck,
  $bootstrapDrugPriceCheck,
  $bootstrapDrugUnitCheck,
  $bootstrapPurchaseCheck
) | ForEach-Object { $referenceDetailPanel.Controls.Add($_) }

$script:UpdatingReferenceChecks = $false
$referenceChildren = @(
  $bootstrapDrugCheck,
  $bootstrapStockCheck,
  $bootstrapBarcodeCheck,
  $bootstrapWholesalerCheck,
  $bootstrapControlledDrugCheck,
  $bootstrapDrugPriceCheck,
  $bootstrapDrugUnitCheck,
  $bootstrapPurchaseCheck
)

$bootstrapReferenceAllCheck.Add_CheckedChanged({
  if ($script:UpdatingReferenceChecks) {
    return
  }
  $script:UpdatingReferenceChecks = $true
  foreach ($child in $referenceChildren) {
    $child.Checked = $bootstrapReferenceAllCheck.Checked
  }
  $script:UpdatingReferenceChecks = $false
})

foreach ($child in $referenceChildren) {
  $child.Add_CheckedChanged({
    if ($script:UpdatingReferenceChecks) {
      return
    }
    $script:UpdatingReferenceChecks = $true
    $allChecked = $true
    foreach ($item in $referenceChildren) {
      if (-not $item.Checked) {
        $allChecked = $false
        break
      }
    }
    $bootstrapReferenceAllCheck.Checked = $allChecked
    $script:UpdatingReferenceChecks = $false
  })
}

$toggleReferenceDetailButton.Add_Click({
  $referenceDetailPanel.Visible = -not $referenceDetailPanel.Visible
  $toggleReferenceDetailButton.Text = if ($referenceDetailPanel.Visible) { "접기" } else { "펼치기" }
})


$notice = New-Label "초기 데이터 동기화는 필요한 항목만 선택하세요. QR 원문은 기본적으로 서버로 보내지 않습니다." 38 696 540 26
$notice.ForeColor = [System.Drawing.Color]::FromArgb(47, 122, 77)
$form.Controls.Add($notice)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = "설치 및 시작"
$installButton.Location = New-Object System.Drawing.Point(350, 746)
$installButton.Size = New-Object System.Drawing.Size(106, 36)
$installButton.BackColor = [System.Drawing.Color]::FromArgb(47, 122, 77)
$installButton.ForeColor = [System.Drawing.Color]::White
$installButton.FlatStyle = "Flat"
$installButton.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($installButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "닫기"
$closeButton.Location = New-Object System.Drawing.Point(468, 746)
$closeButton.Size = New-Object System.Drawing.Size(106, 36)
$closeButton.FlatStyle = "Flat"
$closeButton.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($closeButton)

$closeButton.Add_Click({
  $form.Close()
})

$installButton.Add_Click({
  try {
    $apiBase = $apiBox.Text.Trim()
    $pharmacyId = $pharmacyIdBox.Text.Trim()
    $sqlServer = $sqlBox.Text.Trim()
    $deviceName = $deviceBox.Text.Trim()
    $intervalSeconds = [int]$intervalBox.Text.Trim()

    if ([string]::IsNullOrWhiteSpace($apiBase) -or [string]::IsNullOrWhiteSpace($pharmacyId) -or [string]::IsNullOrWhiteSpace($sqlServer) -or [string]::IsNullOrWhiteSpace($deviceName)) {
      [System.Windows.Forms.MessageBox]::Show("API 주소, 약국 ID, SQL Server, 기기 별칭을 입력하세요.", "PharmFarm Agent", "OK", "Warning") | Out-Null
      return
    }

    $parsedPharmacyId = 0
    if (![int]::TryParse($pharmacyId, [ref]$parsedPharmacyId) -or $parsedPharmacyId -le 0) {
      [System.Windows.Forms.MessageBox]::Show("약국 ID는 CMS에 등록된 숫자 ID여야 합니다.", "PharmFarm Agent", "OK", "Warning") | Out-Null
      return
    }

    if ($intervalSeconds -lt 5) {
      [System.Windows.Forms.MessageBox]::Show("조회 주기는 최소 5초 이상이어야 합니다.", "PharmFarm Agent", "OK", "Warning") | Out-Null
      return
    }

    $configParams = @{
      ApiBase = $apiBase
      PharmacyId = $pharmacyId
      SqlServer = $sqlServer
      DeviceName = $deviceName
      AgentSecret = $secretBox.Text
      IncludeRawQrText = $rawCheck.Checked
      BootstrapDrugMaster = $bootstrapDrugCheck.Checked
      BootstrapStock = $bootstrapStockCheck.Checked
      BootstrapBarcode = $bootstrapBarcodeCheck.Checked
      BootstrapWholesaler = $bootstrapWholesalerCheck.Checked
      BootstrapPurchase = $bootstrapPurchaseCheck.Checked
      BootstrapControlledDrug = $bootstrapControlledDrugCheck.Checked
      BootstrapDrugPrice = $bootstrapDrugPriceCheck.Checked
      BootstrapDrugUnit = $bootstrapDrugUnitCheck.Checked
      IntervalSeconds = $intervalSeconds
    }

    Write-Config @configParams
    $registered = Register-AgentTask

    if ($registered) {
      [System.Windows.Forms.MessageBox]::Show("설치가 완료되었습니다.`r`n로그인 시 자동 실행되며 우측 하단 트레이 아이콘도 함께 시작했습니다.`r`n`r`n설치 위치: $InstallRoot", "PharmFarm Agent", "OK", "Information") | Out-Null
      $form.Close()
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show("설치 중 오류가 발생했습니다.`r`n$($_.Exception.Message)", "PharmFarm Agent", "OK", "Error") | Out-Null
  }
})

[void]$form.ShowDialog()
