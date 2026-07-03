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
$ResyncTodaySource = Join-Path $SourceRoot "resync-today-prescriptions.bat"
$ResyncTodayTarget = Join-Path $InstallRoot "resync-today-prescriptions.bat"
$ControlledDrugReferenceSource = Join-Path $SourceRoot "controlled-drug-reference.csv"
$ControlledDrugReferenceTarget = Join-Path $InstallRoot "controlled-drug-reference.csv"
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
  if (Test-Path -LiteralPath $ResyncTodaySource) {
    Copy-Item -LiteralPath $ResyncTodaySource -Destination $ResyncTodayTarget -Force
  }
  if (Test-Path -LiteralPath $ControlledDrugReferenceSource) {
    Copy-Item -LiteralPath $ControlledDrugReferenceSource -Destination $ControlledDrugReferenceTarget -Force
  }

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
    controlledDrugReferenceCsv = $ControlledDrugReferenceTarget
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

function New-InstallResult {
  param(
    [bool]$Ok,
    [string]$Mode,
    [string]$Message
  )

  return [pscustomobject]@{
    ok = $Ok
    mode = $Mode
    message = $Message
  }
}

function Invoke-ExternalCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  try {
    $output = & $FilePath @Arguments 2>&1 | Out-String
    return [pscustomobject]@{
      exitCode = $LASTEXITCODE
      output = $output.Trim()
    }
  } catch {
    return [pscustomobject]@{
      exitCode = 1
      output = $_.Exception.Message
    }
  }
}

function Ensure-TaskSchedulerService {
  try {
    $service = Get-Service -Name "Schedule" -ErrorAction Stop

    if ($service.Status -ne "Running") {
      try {
        Set-Service -Name "Schedule" -StartupType Automatic -ErrorAction SilentlyContinue
      } catch {
        # Startup type changes require admin rights on some PCs.
      }

      Start-Service -Name "Schedule" -ErrorAction Stop
      $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(10))
    }

    return New-InstallResult $true "service" ""
  } catch {
    return New-InstallResult $false "service" $_.Exception.Message
  }
}

function Start-AgentProcesses {
  param(
    [string]$PowerShellExe,
    [string]$AgentArgument,
    [string]$TrayArgument
  )

  try {
    Start-Process -FilePath $PowerShellExe -ArgumentList $AgentArgument -WindowStyle Hidden | Out-Null
    Start-Process -FilePath $PowerShellExe -ArgumentList $TrayArgument -WindowStyle Hidden | Out-Null
    return New-InstallResult $true "process" ""
  } catch {
    return New-InstallResult $false "process" $_.Exception.Message
  }
}

function Remove-StartupShortcutFallback {
  try {
    $startupDir = [Environment]::GetFolderPath("Startup")
    if ([string]::IsNullOrWhiteSpace($startupDir)) {
      return
    }

    foreach ($name in @("PharmFarmAgent.lnk", "PharmFarmAgentTray.lnk")) {
      $path = Join-Path $startupDir $name
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
  }
}

function Register-AgentTaskWithSchtasks {
  param(
    [string]$PowerShellExe,
    [string]$AgentArgument,
    [string]$TrayArgument
  )

  $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
  if (!(Test-Path -LiteralPath $schtasks) -and (Test-Path -LiteralPath (Join-Path $env:SystemRoot "Sysnative\schtasks.exe"))) {
    $schtasks = Join-Path $env:SystemRoot "Sysnative\schtasks.exe"
  }

  if (!(Test-Path -LiteralPath $schtasks)) {
    return New-InstallResult $false "schtasks" "schtasks.exe를 찾을 수 없습니다."
  }

  $agentCommand = "`"$PowerShellExe`" $AgentArgument"
  $trayCommand = "`"$PowerShellExe`" $TrayArgument"
  $agentCreate = Invoke-ExternalCommand $schtasks @("/Create", "/TN", $TaskName, "/SC", "ONLOGON", "/TR", $agentCommand, "/F")
  if ($agentCreate.exitCode -ne 0) {
    return New-InstallResult $false "schtasks" $agentCreate.output
  }

  $trayCreate = Invoke-ExternalCommand $schtasks @("/Create", "/TN", $TrayTaskName, "/SC", "ONLOGON", "/TR", $trayCommand, "/F")
  if ($trayCreate.exitCode -ne 0) {
    return New-InstallResult $false "schtasks" $trayCreate.output
  }

  [void](Invoke-ExternalCommand $schtasks @("/Run", "/TN", $TaskName))
  [void](Invoke-ExternalCommand $schtasks @("/Run", "/TN", $TrayTaskName))

  Remove-StartupShortcutFallback
  return New-InstallResult $true "schtasks" ""
}

function Install-StartupShortcutFallback {
  param(
    [string]$PowerShellExe,
    [string]$AgentArgument,
    [string]$TrayArgument
  )

  try {
    $startupDir = [Environment]::GetFolderPath("Startup")
    if ([string]::IsNullOrWhiteSpace($startupDir)) {
      throw "시작프로그램 폴더를 찾을 수 없습니다."
    }

    Ensure-Directory $startupDir
    $shell = New-Object -ComObject WScript.Shell

    $agentShortcut = $shell.CreateShortcut((Join-Path $startupDir "PharmFarmAgent.lnk"))
    $agentShortcut.TargetPath = $PowerShellExe
    $agentShortcut.Arguments = $AgentArgument
    $agentShortcut.WorkingDirectory = $InstallRoot
    $agentShortcut.WindowStyle = 7
    $agentShortcut.Save()

    $trayShortcut = $shell.CreateShortcut((Join-Path $startupDir "PharmFarmAgentTray.lnk"))
    $trayShortcut.TargetPath = $PowerShellExe
    $trayShortcut.Arguments = $TrayArgument
    $trayShortcut.WorkingDirectory = $InstallRoot
    $trayShortcut.WindowStyle = 7
    $trayShortcut.Save()

    $startResult = Start-AgentProcesses -PowerShellExe $PowerShellExe -AgentArgument $AgentArgument -TrayArgument $TrayArgument
    if (!$startResult.ok) {
      return New-InstallResult $true "startup" "작업 스케줄러 대신 시작프로그램 등록은 완료했지만 현재 실행은 실패했습니다. $($startResult.message)"
    }

    return New-InstallResult $true "startup" ""
  } catch {
    return New-InstallResult $false "startup" $_.Exception.Message
  }
}

function Register-AgentTask {
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentTarget`""
  $trayArgument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$TrayTarget`""
  $serviceResult = Ensure-TaskSchedulerService
  $errors = New-Object System.Collections.Generic.List[string]

  if (!$serviceResult.ok) {
    [void]$errors.Add("Task Scheduler 서비스 확인 실패: $($serviceResult.message)")
  }

  try {
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $argument
    $trayAction = New-ScheduledTaskAction -Execute $psExe -Argument $trayArgument
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $traySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "PharmFarm Windows prescription collection agent" -Force | Out-Null
    Register-ScheduledTask -TaskName $TrayTaskName -Action $trayAction -Trigger $trigger -Settings $traySettings -Description "PharmFarm tray status icon" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-ScheduledTask -TaskName $TrayTaskName
    Remove-StartupShortcutFallback
    return New-InstallResult $true "scheduled-task" ""
  } catch {
    [void]$errors.Add("PowerShell 예약 작업 등록 실패: $($_.Exception.Message)")
  }

  $schtasksResult = Register-AgentTaskWithSchtasks -PowerShellExe $psExe -AgentArgument $argument -TrayArgument $trayArgument
  if ($schtasksResult.ok) {
    return $schtasksResult
  }
  [void]$errors.Add("schtasks.exe 예약 작업 등록 실패: $($schtasksResult.message)")

  $startupResult = Install-StartupShortcutFallback -PowerShellExe $psExe -AgentArgument $argument -TrayArgument $trayArgument
  if ($startupResult.ok) {
    $message = ($errors.ToArray() -join "`r`n") + "`r`n`r`n작업 스케줄러 대신 시작프로그램으로 등록했습니다. 재부팅 없이 현재 세션에서도 바로 실행했습니다."
    if (![string]::IsNullOrWhiteSpace($startupResult.message)) {
      $message += "`r`n$($startupResult.message)"
    }
    return New-InstallResult $true "startup" $message
  }

  [void]$errors.Add("시작프로그램 fallback 등록 실패: $($startupResult.message)")
  return New-InstallResult $false "failed" ($errors.ToArray() -join "`r`n")
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
    $registerResult = Register-AgentTask

    if ($registerResult.ok) {
      $completeMessage = "설치가 완료되었습니다.`r`n로그인 시 자동 실행되며 우측 하단 트레이 아이콘도 함께 시작했습니다.`r`n`r`n설치 위치: $InstallRoot"
      if ($registerResult.mode -eq "startup") {
        $completeMessage = "설치가 완료되었습니다.`r`n작업 스케줄러 등록이 실패해 시작프로그램 방식으로 대체 등록했습니다.`r`n재부팅 없이 현재 세션에서도 바로 실행했습니다.`r`n`r`n설치 위치: $InstallRoot"
      } elseif ($registerResult.mode -eq "schtasks") {
        $completeMessage = "설치가 완료되었습니다.`r`nPowerShell 예약 작업 등록이 실패해 schtasks.exe로 대체 등록했습니다.`r`n`r`n설치 위치: $InstallRoot"
      }

      if (![string]::IsNullOrWhiteSpace($registerResult.message)) {
        $completeMessage += "`r`n`r`n세부 정보:`r`n$($registerResult.message)"
      }

      [System.Windows.Forms.MessageBox]::Show($completeMessage, "PharmFarm Agent", "OK", "Information") | Out-Null
      $form.Close()
    } else {
      [System.Windows.Forms.MessageBox]::Show("예약 작업 등록에 실패했습니다.`r`n$($registerResult.message)`r`n`r`n관리자 권한으로 다시 실행하거나 run-agent-console.bat으로 수동 실행하세요.", "PharmFarm Agent", "OK", "Warning") | Out-Null
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show("설치 중 오류가 발생했습니다.`r`n$($_.Exception.Message)", "PharmFarm Agent", "OK", "Error") | Out-Null
  }
})

[void]$form.ShowDialog()
