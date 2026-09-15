param(
  [switch]$Resume,
  [string]$InstallRoot = (Join-Path $env:ProgramData "PharmFarmAgent")
)

$ErrorActionPreference = "Continue"

$AppName = "PharmFarmAgent"
$TaskName = "PharmFarmAgent"
. (Join-Path $PSScriptRoot "PharmFarm-AgentLifecycle.ps1")
$AgentScript = Join-Path $InstallRoot "PharmFarm-Agent.ps1"
$IconFile = Join-Path $InstallRoot "PharmFarm-Agent.ico"
$ConfigFile = Join-Path $InstallRoot "agent.config.json"
$StateFile = Join-Path $InstallRoot "agent.state.json"
$RecoveryStateFile = Join-Path $InstallRoot "agent.recovery-required.json"
$LogDir = Join-Path $InstallRoot "logs"
$QueueDir = Join-Path $InstallRoot "queue"
$SentDir = Join-Path $InstallRoot "sent"
$DeadDir = Join-Path $InstallRoot "dead-letter"
$BootstrapStateFile = Join-Path $InstallRoot "bootstrap.state.json"
$SyncStateDir = Join-Path $InstallRoot "sync-state"
$UiAlertDir = Join-Path $InstallRoot "ui-alerts"
$UiAlertShownDir = Join-Path $InstallRoot "ui-alerts-shown"
$UiAlertFailedDir = Join-Path $InstallRoot "ui-alerts-failed"

function Ensure-Directory {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) {
    [void](New-Item -ItemType Directory -Force -Path $Path -ErrorAction Stop)
  }
}

function Get-PharmFarmTrayIcon {
  $script:ownsTrayIcon = $false
  if (!(Test-Path -LiteralPath $IconFile)) {
    return [System.Drawing.SystemIcons]::Application
  }

  try {
    $sourceIcon = New-Object System.Drawing.Icon($IconFile)
    try {
      $script:ownsTrayIcon = $true
      return $sourceIcon.Clone()
    } finally {
      $sourceIcon.Dispose()
    }
  } catch {
    return [System.Drawing.SystemIcons]::Application
  }
}

function Read-State {
  if (!(Test-Path -LiteralPath $StateFile)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Value,
    [int]$Depth = 8
  )

  try {
    $json = $Value | ConvertTo-Json -Depth $Depth
    $tmp = "$Path.tmp"
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Get-QueueCount {
  if (!(Test-Path -LiteralPath $QueueDir)) {
    return 0
  }

  return @(Get-ChildItem -LiteralPath $QueueDir -Filter "*.json" -File -ErrorAction SilentlyContinue).Count
}

function Get-AgentTaskState {
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    return $task.State.ToString()
  } catch {
    return "NotInstalled"
  }
}

function Get-AgentProcesses {
  return @(Get-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("agent"))
}

function Test-AgentRuntimeRunning {
  param([string]$RuntimeState)

  return $RuntimeState -eq "Running" -or $RuntimeState -eq "RunningFallback"
}

function Get-AgentRuntimeState {
  try {
    if ((Test-PharmFarmRuntimeLocked -InstallRoot $InstallRoot -Role "agent") -or @(Get-AgentProcesses).Count -gt 0) {
      return "Running"
    }
    if (Test-PharmFarmPaused -InstallRoot $InstallRoot -Role "agent") {
      return "Paused"
    }
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role "agent")) {
      return "Maintenance"
    }
    $taskState = Get-AgentTaskState
    if ($taskState -eq "Running") { return "Starting" }
    return $taskState
  } catch {
    # Inspection failure must not be mistaken for a stopped process.
    return "Unknown"
  }
}

function Get-AgentRuntimeStateLabel {
  param([string]$RuntimeState)

  switch ($RuntimeState) {
    "Running" { return "프로세스 실행 중" }
    "RunningFallback" { return "프로세스 실행 중" }
    "Starting" { return "시작 확인 중" }
    "Paused" { return "사용자에 의해 중지됨" }
    "Maintenance" { return "점검/설치/제거 중 · 자동 시작 보류" }
    "Unknown" { return "실행 상태 확인 실패" }
    "Ready" { return "중지됨" }
    "Disabled" { return "예약 작업 사용 안 함" }
    "NotInstalled" { return "설치 확인 필요" }
    default { return $RuntimeState }
  }
}

function Open-Folder {
  param([string]$Path)
  Ensure-Directory $Path
  Start-Process explorer.exe $Path
}

function Start-AgentTask {
  param(
    [switch]$Automatic,
    [switch]$Silent
  )

  try {
    $wasPaused = Test-PharmFarmPaused -InstallRoot $InstallRoot -Role "agent"
    if (!$Automatic) {
      Set-PharmFarmPaused -InstallRoot $InstallRoot -Role "agent" -Paused $false
    }
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role "agent")) {
      if (!$Automatic -and $wasPaused) {
        Set-PharmFarmPaused -InstallRoot $InstallRoot -Role "agent" -Paused $true
      }
      throw "사용자 중지 또는 점검/설치/제거 중이므로 시작하지 않습니다."
    }
    $runtimeState = Get-AgentRuntimeState
    if ($runtimeState -eq "Unknown") { throw "기존 에이전트의 실행 상태를 확인할 수 없습니다." }
    if ((Test-AgentRuntimeRunning $runtimeState) -or $runtimeState -eq "Starting") { return $true }
    $taskState = Get-AgentTaskState
    if ($taskState -eq "NotInstalled") {
      if (!(Test-Path -LiteralPath $AgentScript)) {
        throw "에이전트 파일을 찾을 수 없습니다."
      }

      Start-PharmFarmHiddenRuntime -InstallRoot $InstallRoot -Role agent
    } else {
      Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    }

    if (!$Silent) {
      Show-Balloon "PharmFarm" "처방 수집 에이전트 시작을 요청했습니다. 잠시 후 상태를 다시 확인합니다." "Info" 4000
    }
    return $true
  } catch {
    if (!$Silent) {
      Show-Balloon "PharmFarm - 처방 수집 중지" "시작하지 못했습니다: $($_.Exception.Message) 로그 폴더를 확인하고 관리자에게 문의해 주세요." "Error" 10000
    }
    return $false
  }
}

function Stop-AgentTask {
  try {
    # Persist intent before stopping so the watchdog cannot race this action.
    Set-PharmFarmPaused -InstallRoot $InstallRoot -Role "agent" -Paused $true
    Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("agent")
    Show-Balloon "PharmFarm - 처방 수집 중지" "에이전트를 중지했습니다. PC를 다시 켜도 중지가 유지됩니다. 다시 수집하려면 '에이전트 시작'을 눌러 주세요." "Warning" 10000
  } catch {
    Show-Balloon "PharmFarm" "중지 완료를 확인하지 못했습니다: $($_.Exception.Message) 관리자에게 문의해 주세요." "Error" 10000
  }
}

function Reset-BootstrapFlags {
  param([string[]]$Keys)

  $state = $null
  if (Test-Path -LiteralPath $BootstrapStateFile) {
    try {
      $state = Get-Content -LiteralPath $BootstrapStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      $state = $null
    }
  }

  if ($null -eq $state) {
    $state = [pscustomobject][ordered]@{}
  }

  foreach ($key in $Keys) {
    if ($null -eq $state.PSObject.Properties[$key]) {
      $state | Add-Member -NotePropertyName $key -NotePropertyValue $false
    } else {
      $state.$key = $false
    }
  }

  if ($null -eq $state.PSObject.Properties["manualSyncRequestedAt"]) {
    $state | Add-Member -NotePropertyName "manualSyncRequestedAt" -NotePropertyValue ([DateTimeOffset]::Now.ToString("o"))
  } else {
    $state.manualSyncRequestedAt = [DateTimeOffset]::Now.ToString("o")
  }

  if (!(Write-JsonFile -Path $BootstrapStateFile -Value $state -Depth 8)) {
    throw "재동기화 상태를 저장하지 못했습니다."
  }
}

function Remove-SyncHash {
  param([string]$Kind)

  $path = Join-Path $SyncStateDir ("{0}.hashes.json" -f $Kind)
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  }
}

function Complete-AgentMaintenance {
  param($Lease, [bool]$Success, [string]$Operation, [string]$PriorError = "")

  if ($null -eq $Lease) { return $Success }
  try {
    Exit-PharmFarmMaintenance -InstallRoot $InstallRoot -Lease $Lease -Success:$Success
    return $Success
  } catch {
    $details = "점검 종료 오류: $($_.Exception.Message)"
    if (![string]::IsNullOrWhiteSpace($PriorError)) {
      $details = "작업 오류: $PriorError / $details"
    }
    Show-Balloon "PharmFarm - 복구 확인 필요" "$Operation 완료를 확인하지 못해 자동 시작하지 않습니다. 관리자에게 문의하고 repair-pharmfarm-agent.bat로 복구해 주세요. $details" "Error" 15000
    return $false
  }
}

function Restart-AgentTask {
  $lease = $null
  $success = $false
  $failureMessage = ""
  try {
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role "agent")) { return $false }
    $lease = Enter-PharmFarmMaintenance -InstallRoot $InstallRoot -Reason "tray-restart"
    if ($null -eq $lease) { throw "다른 점검 작업이 진행 중입니다." }
    Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("agent")
    $success = $true
  } catch {
    $failureMessage = $_.Exception.Message
    Show-Balloon "PharmFarm" "에이전트 재시작 실패: $failureMessage 관리자에게 문의해 주세요." "Error" 10000
  } finally {
    $success = Complete-AgentMaintenance -Lease $lease -Success $success -Operation "에이전트 재시작" -PriorError $failureMessage
  }
  if (!$success) { return $false }
  return (Start-AgentTask -Automatic -Silent)
}

function Get-PowerShellExe {
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $sysnative = Join-Path $env:SystemRoot "Sysnative\WindowsPowerShell\v1.0\powershell.exe"

  if (Test-Path -LiteralPath $sysnative) {
    return $sysnative
  }

  return $psExe
}

function Request-TodayPrescriptionOverwrite {
  if (!(Test-Path -LiteralPath $AgentScript)) {
    Show-Balloon "PharmFarm" "에이전트 파일을 찾지 못했습니다." "Error" 5000
    return $false
  }

  $psExe = Get-PowerShellExe
  if (!(Test-Path -LiteralPath $psExe)) {
    Show-Balloon "PharmFarm" "Windows PowerShell을 찾지 못했습니다." "Error" 5000
    return $false
  }

  $completed = $false
  $lease = $null
  $failureMessage = ""
  try {
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role "agent")) {
      throw "사용자 중지 상태면 먼저 '에이전트 시작'을 누르세요. 점검/설치/제거 중에는 실행할 수 없습니다."
    }
    $lease = Enter-PharmFarmMaintenance -InstallRoot $InstallRoot -Reason "tray-today-prescription-overwrite"
    if ($null -eq $lease) { throw "다른 점검 작업이 진행 중입니다." }
    Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("agent")

    $process = Start-PharmFarmHiddenRuntime -InstallRoot $InstallRoot -Role agent -ResyncTodayPrescriptions -MaintenanceToken $lease.Token -Wait

    if ($process.ExitCode -eq 0) {
      $completed = $true
    } else {
      throw "재전송 작업이 종료 코드 $($process.ExitCode)(으)로 실패했습니다."
    }
  } catch {
    $failureMessage = $_.Exception.Message
    $completed = $false
    Show-Balloon "PharmFarm" "오늘 처방 재전송 실패: $failureMessage 안전을 위해 자동 시작을 보류했을 수 있습니다. 관리자에게 문의해 주세요." "Error" 12000
  } finally {
    $completed = Complete-AgentMaintenance -Lease $lease -Success $completed -Operation "오늘 처방 재전송" -PriorError $failureMessage
  }
  if ($completed) {
    if (Test-Path -LiteralPath $RecoveryStateFile) {
      Remove-Item -LiteralPath $RecoveryStateFile -Force -ErrorAction SilentlyContinue
    }
    if (Start-AgentTask -Automatic -Silent) {
      Show-Balloon "PharmFarm" "오늘 처방 재전송 큐 작성을 완료했습니다. 서버 수집 완료 여부는 관리자 화면에서 확인해 주세요." "Info" 7000
    } else {
      Show-Balloon "PharmFarm" "오늘 처방 재전송 큐는 작성했지만 에이전트 시작에 실패했습니다. '에이전트 시작'을 누르고 관리자 화면에서 수집 결과를 확인해 주세요." "Error" 10000
    }
  }

  return $completed
}

function Invoke-AgentStateReset {
  param([string]$Label, [scriptblock]$ResetState)

  $lease = $null
  $success = $false
  $failureMessage = ""
  try {
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role "agent")) {
      throw "사용자 중지 상태면 먼저 '에이전트 시작'을 누르세요. 점검/설치/제거 중에는 실행할 수 없습니다."
    }
    $lease = Enter-PharmFarmMaintenance -InstallRoot $InstallRoot -Reason "tray-reference-resync"
    if ($null -eq $lease) { throw "다른 점검 작업이 진행 중입니다." }
    Stop-PharmFarmProcesses -InstallRoot $InstallRoot -Roles @("agent")
    Ensure-Directory $SyncStateDir
    & $ResetState
    $success = $true
  } catch {
    $failureMessage = $_.Exception.Message
    $success = $false
    Show-Balloon "PharmFarm" "$Label 준비 실패: $failureMessage 자동 시작을 보류했을 수 있습니다. 관리자에게 문의해 주세요." "Error" 12000
  } finally {
    $success = Complete-AgentMaintenance -Lease $lease -Success $success -Operation $Label -PriorError $failureMessage
  }
  if ($success) {
    if (Start-AgentTask -Automatic -Silent) {
      Show-Balloon "PharmFarm" "$Label 시작을 요청했습니다. 관리자 화면에서 결과를 확인해 주세요."
    } else {
      Show-Balloon "PharmFarm" "$Label 준비는 완료했지만 에이전트 시작에 실패했습니다. '에이전트 시작'을 누르고 로그를 확인해 주세요." "Error" 10000
    }
  }
}

function Request-ReferenceResync {
  Invoke-AgentStateReset -Label "참조 데이터 전체 재동기화" -ResetState {
    foreach ($kind in @("drug-master", "stock", "barcode", "wholesaler", "controlled-drug", "controlled-drug-product-info", "controlled-drug-master", "drug-price", "drug-unit")) {
      Remove-SyncHash $kind
    }
    if (Test-Path -LiteralPath $BootstrapStateFile) {
      Remove-Item -LiteralPath $BootstrapStateFile -Force -ErrorAction Stop
    }
  }
}

function Request-ControlledDrugResync {
  Invoke-AgentStateReset -Label "향정 후보 재동기화" -ResetState {
    Remove-SyncHash "controlled-drug"
    Remove-SyncHash "controlled-drug-product-info"
    Remove-SyncHash "controlled-drug-master"
    Reset-BootstrapFlags @("controlledDrugReferenceCompleted", "controlledDrugProductInfoCompleted", "controlledDrugCompleted", "controlledDrugMasterCompleted")
  }
}

function Show-Balloon {
  param(
    [string]$Title,
    [string]$Text,
    [ValidateSet("None", "Info", "Warning", "Error")]
    [string]$Icon = "Info",
    [int]$DurationMilliseconds = 2500
  )

  $script:notifyIcon.BalloonTipTitle = $Title
  $script:notifyIcon.BalloonTipText = $Text
  $script:notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]$Icon
  $script:notifyIcon.ShowBalloonTip($DurationMilliseconds)
}

function Get-AlertValue {
  param(
    [object]$Object,
    [string]$Name,
    $DefaultValue = $null
  )

  if ($null -eq $Object -or $null -eq $Object.PSObject -or $null -eq $Object.PSObject.Properties[$Name]) {
    return $DefaultValue
  }

  return $Object.PSObject.Properties[$Name].Value
}

function Get-AlertQuantityText {
  param(
    $Value,
    [string]$Fallback = "-"
  )

  if ($null -eq $Value -or $Value -is [DBNull]) {
    return $Fallback
  }

  try {
    return ([decimal]$Value).ToString("0.##")
  } catch {
    return $Fallback
  }
}

function Get-AlertDisplayText {
  param(
    $Value,
    [string]$Fallback = "-"
  )

  if ($null -eq $Value) {
    return $Fallback
  }

  $text = $Value.ToString()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $Fallback
  }

  if ($text -match "[가-힣]") {
    return $text
  }

  try {
    $latin1 = [Text.Encoding]::GetEncoding(28591)
    $decoded = [Text.Encoding]::UTF8.GetString($latin1.GetBytes($text))
    if ($decoded -match "[가-힣]") {
      return $decoded
    }
  } catch {
  }

  return $text
}

function Add-AlertGridColumn {
  param(
    [System.Windows.Forms.DataGridView]$Grid,
    [string]$Name,
    [string]$Header,
    [int]$Width,
    [bool]$Fill = $false
  )

  $column = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
  $column.Name = $Name
  $column.HeaderText = $Header
  $column.SortMode = [System.Windows.Forms.DataGridViewColumnSortMode]::NotSortable
  if ($Fill) {
    $column.AutoSizeMode = [System.Windows.Forms.DataGridViewAutoSizeColumnMode]::Fill
  } else {
    $column.Width = $Width
  }
  [void]$Grid.Columns.Add($column)
}

function Show-PrescriptionStockAlert {
  param([object]$Alert)

  $isSuccessPreview = (Get-AlertValue -Object $Alert -Name "successPreview" -DefaultValue $false) -eq $true
  if ($isSuccessPreview) {
    return
  }

  $rows = @((Get-AlertValue -Object $Alert -Name "rows" -DefaultValue @()) | Where-Object { $null -ne $_ })
  if ($rows.Count -eq 0) {
    return
  }

  $prescriptionCodes = @((Get-AlertValue -Object $Alert -Name "prescriptionCodes" -DefaultValue @()) | Where-Object { ![string]::IsNullOrWhiteSpace($_) })
  $prescriptionLabel = if ($prescriptionCodes.Count -gt 0) { $prescriptionCodes -join ", " } else { "처방전" }
  $shortageCount = @($rows | Where-Object { (Get-AlertValue -Object $_ -Name "alertType" -DefaultValue "") -eq "SHORTAGE" }).Count
  $lowStockCount = $rows.Count - $shortageCount

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "PharmFarm 처방 재고 알림"
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.Size = New-Object System.Drawing.Size(920, ([Math]::Min(720, [Math]::Max(420, 250 + ($rows.Count * 34)))))
  $form.MinimumSize = New-Object System.Drawing.Size(820, 420)
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.BackColor = [System.Drawing.Color]::FromArgb(247, 249, 243)

  $brandImage = $null
  if ($null -ne $script:trayIcon) {
    try {
      $brandImage = $script:trayIcon.ToBitmap()
      $brand = New-Object System.Windows.Forms.PictureBox
      $brand.Image = $brandImage
      $brand.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
      $brand.Location = New-Object System.Drawing.Point(26, 19)
      $brand.Size = New-Object System.Drawing.Size(36, 36)
      $form.Controls.Add($brand)
    } catch {
      $brandImage = $null
    }
  }

  $title = New-Object System.Windows.Forms.Label
  $title.Text = "처방 재고를 확인해 주세요"
  $title.Location = New-Object System.Drawing.Point(72, 18)
  $title.Size = New-Object System.Drawing.Size(794, 32)
  $title.Font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
  $title.ForeColor = [System.Drawing.Color]::FromArgb(32, 35, 29)
  $form.Controls.Add($title)

  $summary = New-Object System.Windows.Forms.Label
  $summary.Text = "$prescriptionLabel · 부족 $shortageCount건 · 처방 후 1개 미만 $lowStockCount건"
  $summary.Location = New-Object System.Drawing.Point(75, 50)
  $summary.Size = New-Object System.Drawing.Size(790, 24)
  $summary.Font = New-Object System.Drawing.Font("Segoe UI", 10)
  $summary.ForeColor = [System.Drawing.Color]::FromArgb(104, 112, 97)
  $form.Controls.Add($summary)

  $source = New-Object System.Windows.Forms.Label
  $source.Text = "기준 재고: PharmFarm 서비스 현재고"
  $source.Location = New-Object System.Drawing.Point(29, 83)
  $source.Size = New-Object System.Drawing.Size(840, 22)
  $source.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
  $source.ForeColor = [System.Drawing.Color]::FromArgb(47, 122, 77)
  $form.Controls.Add($source)

  $grid = New-Object System.Windows.Forms.DataGridView
  $grid.Location = New-Object System.Drawing.Point(28, 116)
  $grid.Size = New-Object System.Drawing.Size(848, ($form.ClientSize.Height - 182))
  $grid.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
  $grid.AllowUserToAddRows = $false
  $grid.AllowUserToDeleteRows = $false
  $grid.AllowUserToResizeRows = $false
  $grid.ReadOnly = $true
  $grid.MultiSelect = $false
  $grid.RowHeadersVisible = $false
  $grid.SelectionMode = [System.Windows.Forms.DataGridViewSelectionMode]::FullRowSelect
  $grid.BackgroundColor = [System.Drawing.Color]::FromArgb(255, 255, 253)
  $grid.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  $grid.AutoSizeRowsMode = [System.Windows.Forms.DataGridViewAutoSizeRowsMode]::AllCells
  $grid.DefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9)
  $grid.DefaultCellStyle.WrapMode = [System.Windows.Forms.DataGridViewTriState]::True
  $grid.DefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(255, 255, 253)
  $grid.DefaultCellStyle.ForeColor = [System.Drawing.Color]::FromArgb(32, 35, 29)
  $grid.DefaultCellStyle.SelectionBackColor = [System.Drawing.Color]::FromArgb(225, 237, 219)
  $grid.DefaultCellStyle.SelectionForeColor = [System.Drawing.Color]::FromArgb(32, 35, 29)
  $grid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(250, 251, 247)
  $grid.EnableHeadersVisualStyles = $false
  $grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
  $grid.ColumnHeadersDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(235, 241, 229)
  $grid.ColumnHeadersDefaultCellStyle.ForeColor = [System.Drawing.Color]::FromArgb(58, 69, 52)
  $grid.ColumnHeadersDefaultCellStyle.SelectionBackColor = [System.Drawing.Color]::FromArgb(235, 241, 229)
  $grid.ColumnHeadersDefaultCellStyle.SelectionForeColor = [System.Drawing.Color]::FromArgb(58, 69, 52)
  $grid.ColumnHeadersHeight = 34
  $grid.RowTemplate.Height = 32

  Add-AlertGridColumn -Grid $grid -Name "line" -Header "행" -Width 52
  Add-AlertGridColumn -Grid $grid -Name "drug" -Header "약품명" -Width 260 -Fill $true
  Add-AlertGridColumn -Grid $grid -Name "requested" -Header "처방량" -Width 78
  Add-AlertGridColumn -Grid $grid -Name "before" -Header "처방 전" -Width 78
  Add-AlertGridColumn -Grid $grid -Name "after" -Header "처방 후" -Width 78
  Add-AlertGridColumn -Grid $grid -Name "shortage" -Header "부족" -Width 70
  Add-AlertGridColumn -Grid $grid -Name "status" -Header "상태" -Width 105

  foreach ($row in $rows) {
    $alertType = Get-AlertValue -Object $row -Name "alertType" -DefaultValue "SHORTAGE"
    $matched = Get-AlertValue -Object $row -Name "matchedServiceStock" -DefaultValue $true
    $statusText = if (!$matched) { "재고 연결 없음" } elseif ($alertType -eq "SHORTAGE") { "재고 부족" } else { "1개 미만" }
    $beforeText = if (!$matched) { "연결 없음" } else { Get-AlertQuantityText -Value (Get-AlertValue -Object $row -Name "stockBeforeQuantity") }
    $afterText = if (!$matched) { "-" } else { Get-AlertQuantityText -Value (Get-AlertValue -Object $row -Name "stockAfterQuantity") }
    $rowIndex = $grid.Rows.Add(
      (Get-AlertValue -Object $row -Name "lineNo" -DefaultValue "-"),
      (Get-AlertDisplayText -Value (Get-AlertValue -Object $row -Name "drugName" -DefaultValue "미확인 약품") -Fallback "미확인 약품"),
      (Get-AlertQuantityText -Value (Get-AlertValue -Object $row -Name "requestedQuantity")),
      $beforeText,
      $afterText,
      (Get-AlertQuantityText -Value (Get-AlertValue -Object $row -Name "shortageQuantity") -Fallback "0"),
      $statusText
    )
    $gridRow = $grid.Rows[$rowIndex]
    if (!$matched) {
      $gridRow.DefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(249, 247, 252)
      $gridRow.Cells[6].Style.ForeColor = [System.Drawing.Color]::FromArgb(105, 78, 142)
      $gridRow.Cells[6].Style.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    } elseif ($alertType -eq "SHORTAGE") {
      $gridRow.DefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(255, 251, 249)
      $gridRow.Cells[5].Style.ForeColor = [System.Drawing.Color]::FromArgb(188, 68, 58)
      $gridRow.Cells[5].Style.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
      $gridRow.Cells[6].Style.ForeColor = [System.Drawing.Color]::FromArgb(188, 68, 58)
      $gridRow.Cells[6].Style.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    } else {
      $gridRow.DefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(255, 253, 247)
      $gridRow.Cells[6].Style.ForeColor = [System.Drawing.Color]::FromArgb(164, 110, 30)
      $gridRow.Cells[6].Style.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    }
  }
  $grid.ClearSelection()
  $form.Controls.Add($grid)

  $closeButton = New-Object System.Windows.Forms.Button
  $closeButton.Text = "확인했어요"
  $closeButton.Size = New-Object System.Drawing.Size(110, 36)
  $closeButton.Location = New-Object System.Drawing.Point(($form.ClientSize.Width - 138), ($form.ClientSize.Height - 50))
  $closeButton.Anchor = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right
  $closeButton.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
  $closeButton.BackColor = [System.Drawing.Color]::FromArgb(63, 125, 88)
  $closeButton.ForeColor = [System.Drawing.Color]::White
  $closeButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $closeButton.FlatAppearance.BorderSize = 0
  $closeButton.Add_Click({ $form.DialogResult = [System.Windows.Forms.DialogResult]::OK; $form.Close() })
  $form.AcceptButton = $closeButton
  $form.Controls.Add($closeButton)

  [System.Media.SystemSounds]::Asterisk.Play()
  [void]$form.ShowDialog()
  $form.Dispose()
  if ($null -ne $brandImage) {
    $brandImage.Dispose()
  }
}

function Check-PrescriptionStockAlerts {
  if ($script:showingStockAlert) {
    return
  }

  Ensure-Directory $UiAlertDir
  $file = Get-ChildItem -LiteralPath $UiAlertDir -Filter "*.json" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime |
    Select-Object -First 1
  if ($null -eq $file) {
    return
  }

  $script:showingStockAlert = $true
  try {
    $alert = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    Show-PrescriptionStockAlert -Alert $alert
    Ensure-Directory $UiAlertShownDir
    Move-Item -LiteralPath $file.FullName -Destination (Join-Path $UiAlertShownDir $file.Name) -Force
  } catch {
    Ensure-Directory $UiAlertFailedDir
    Move-Item -LiteralPath $file.FullName -Destination (Join-Path $UiAlertFailedDir $file.Name) -Force -ErrorAction SilentlyContinue
    Show-Balloon "PharmFarm" "처방 재고 알림을 표시하지 못했습니다. 로그 폴더를 확인하세요."
  } finally {
    $script:showingStockAlert = $false
  }
}

function Set-AgentRecoveryRequired {
  param(
    [string]$Reason,
    [object]$State
  )

  if (Test-Path -LiteralPath $RecoveryStateFile) {
    return
  }

  $lastAgentUpdateAt = ""
  if ($null -ne $State -and $null -ne $State.PSObject.Properties["updatedAt"] -and $State.updatedAt) {
    $lastAgentUpdateAt = $State.updatedAt.ToString()
  }

  $recoveryState = [ordered]@{
    detectedAt = [DateTimeOffset]::Now.ToString("o")
    reason = $Reason
    lastAgentUpdateAt = $lastAgentUpdateAt
    action = "Verify today's prescriptions in the admin page. Ask an administrator before using the full overwrite resync action."
  }
  [void](Write-JsonFile -Path $RecoveryStateFile -Value $recoveryState -Depth 6)
}

function Invoke-AgentAutoRecovery {
  param(
    [string]$RuntimeState,
    [object]$State
  )

  if (Test-AgentRuntimeRunning $RuntimeState) {
    return $RuntimeState
  }

  if ($RuntimeState -in @("Unknown", "Starting", "Paused", "Maintenance")) {
    return $RuntimeState
  }
  try {
    if (!(Test-PharmFarmStartAllowed -InstallRoot $InstallRoot -Role "agent")) { return $RuntimeState }
  } catch { return "Unknown" }

  $now = Get-Date
  if (($now - $script:trayStartedAt).TotalSeconds -lt $script:startupGraceSeconds) {
    return $RuntimeState
  }

  if (($now - $script:lastAutoStartAttemptAt).TotalSeconds -lt $script:autoStartRetrySeconds) {
    return $RuntimeState
  }

  $script:lastAutoStartAttemptAt = $now
  Set-AgentRecoveryRequired -Reason $RuntimeState -State $State
  $startRequested = Start-AgentTask -Automatic -Silent
  Start-Sleep -Milliseconds 1200
  $recoveredState = Get-AgentRuntimeState

  if ($startRequested -and (Test-AgentRuntimeRunning $recoveredState)) {
    Show-Balloon "PharmFarm - 자동 재시작" "중지된 에이전트 프로세스를 다시 시작했습니다. 수집·서버 연결 복구 여부와 중지 시간의 누락은 관리자 화면에서 확인해 주세요." "Warning" 10000
    return $recoveredState
  }

  if (($now - $script:lastStoppedNoticeAt).TotalSeconds -ge $script:stoppedNoticeRepeatSeconds) {
    $script:lastStoppedNoticeAt = $now
    Show-Balloon "PharmFarm - 처방 수집 중지" "자동 재시작에 실패했습니다. 아이콘을 우클릭해 '에이전트 시작'을 누르세요. 계속 실패하면 로그 폴더를 확인하고 관리자에게 문의해 주세요." "Error" 12000
  }

  return $recoveredState
}

function Update-TrayStatus {
  $state = Read-State
  $runtimeState = Get-AgentRuntimeState
  if (!(Test-AgentRuntimeRunning $runtimeState)) {
    $runtimeState = Invoke-AgentAutoRecovery -RuntimeState $runtimeState -State $state
  }

  $queueCount = Get-QueueCount
  $status = "대기 중"
  $message = "상태 파일을 기다리는 중"

  if ($null -ne $state) {
    $status = if ($state.status) { $state.status.ToString() } else { "UNKNOWN" }
    $message = if ($state.message) { $state.message.ToString() } else { "상태 메시지 없음" }
  }

  $runtimeRunning = Test-AgentRuntimeRunning $runtimeState
  $runtimeLabel = Get-AgentRuntimeStateLabel $runtimeState
  $recoveryRequired = Test-Path -LiteralPath $RecoveryStateFile

  if ($runtimeRunning) {
    $script:notifyIcon.Icon = if ($status -eq "ERROR") { [System.Drawing.SystemIcons]::Warning } else { $script:trayIcon }
    $tooltip = "PharmFarm 에이전트 실행 중 · 상태 $status · 대기 $queueCount"
    $script:statusItem.Text = "에이전트: $runtimeLabel / 최근 상태: $status / 전송 대기: $queueCount"

    if ($recoveryRequired) {
      $script:messageItem.Text = "주의: 중지 시간의 누락 가능 · 오늘 처방 확인 필요"
    } else {
      $script:messageItem.Text = "최근: $message"
    }
  } else {
    $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
    $tooltip = "PharmFarm 처방 수집 중지됨 · 확인 필요"

    if ($runtimeState -eq "Paused") {
      $script:statusItem.Text = "처방 수집: 사용자에 의해 중지됨 / 전송 대기: $queueCount"
      $script:messageItem.Text = "PC 재시작 후에도 중지 유지 · 조치: 우클릭 → 에이전트 시작"
    } elseif ($runtimeState -eq "Maintenance") {
      $script:statusItem.Text = "처방 수집: 점검/설치/제거 중 · 자동 시작 보류"
      $script:messageItem.Text = "작업 종료 후에도 계속되면 관리자에게 문의해 주세요."
    } elseif ($runtimeState -eq "Unknown") {
      $script:statusItem.Text = "에이전트 실행 상태 확인 실패 · 자동 시작 보류"
      $script:messageItem.Text = "조치: 로그 확인/관리자 문의 · 중복 실행 방지를 위해 확인 필요"
    } elseif ($runtimeState -eq "Starting") {
      $script:statusItem.Text = "예약 작업 실행 중 · 에이전트 프로세스 시작 확인 중"
      $script:messageItem.Text = "계속 이 상태이면 로그 폴더를 확인하고 관리자에게 문의해 주세요."
    } elseif (((Get-Date) - $script:trayStartedAt).TotalSeconds -lt $script:startupGraceSeconds) {
      $script:statusItem.Text = "처방 수집: 시작 상태 확인 중 / 전송 대기: $queueCount"
      $script:messageItem.Text = "잠시 후 자동으로 다시 확인합니다."
    } else {
      $script:statusItem.Text = "처방 수집: $runtimeLabel / 자동 재시작 시도 중"
      $script:messageItem.Text = "조치: '에이전트 시작' 클릭 · 실패 시 로그 확인/관리자 문의"
    }
  }

  if ($tooltip.Length -gt 63) {
    $tooltip = $tooltip.Substring(0, 63)
  }
  $script:notifyIcon.Text = $tooltip

  if ($null -ne $script:resyncTodayPrescriptionItem) {
    if ($recoveryRequired) {
      $script:resyncTodayPrescriptionItem.Text = "오늘 처방 전체 재전송 (덮어쓰기 · 관리자 확인 필요)"
      $script:resyncTodayPrescriptionItem.ForeColor = [System.Drawing.Color]::DarkRed
    } else {
      $script:resyncTodayPrescriptionItem.Text = "오늘 처방 전체 재전송 (덮어쓰기)"
      $script:resyncTodayPrescriptionItem.ForeColor = [System.Drawing.SystemColors]::ControlText
    }
  }

  return $runtimeState
}

$trayRuntimeLock = $null
try {
Ensure-Directory $InstallRoot
if ($Resume) {
  Set-PharmFarmPaused -InstallRoot $InstallRoot -Role "tray" -Paused $false
}
$trayRuntimeLock = Enter-PharmFarmRuntime -InstallRoot $InstallRoot -Role "tray"
if ($null -eq $trayRuntimeLock) { exit 0 }
Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
Add-Type -AssemblyName System.Drawing -ErrorAction Stop
Ensure-Directory $LogDir
Ensure-Directory $QueueDir
Ensure-Directory $SentDir
Ensure-Directory $DeadDir
Ensure-Directory $UiAlertDir
Ensure-Directory $UiAlertShownDir
Ensure-Directory $UiAlertFailedDir

$script:trayStartedAt = Get-Date
$script:startupGraceSeconds = 20
$script:autoStartRetrySeconds = 60
$script:stoppedNoticeRepeatSeconds = 900
$script:lastAutoStartAttemptAt = [DateTime]::MinValue
$script:lastStoppedNoticeAt = [DateTime]::MinValue

$script:trayIcon = Get-PharmFarmTrayIcon
$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:notifyIcon.Icon = $script:trayIcon
$script:notifyIcon.Text = "PharmFarm 처방 수집 상태 확인 중"
$script:notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:statusItem.Text = "상태 확인 중"
$script:statusItem.Enabled = $false
$menu.Items.Add($script:statusItem) | Out-Null

$script:messageItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:messageItem.Text = "최근: -"
$script:messageItem.Enabled = $false
$menu.Items.Add($script:messageItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$refreshItem = New-Object System.Windows.Forms.ToolStripMenuItem
$refreshItem.Text = "상태 새로고침"
$refreshItem.Add_Click({ Update-TrayStatus })
$menu.Items.Add($refreshItem) | Out-Null

$openRootItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openRootItem.Text = "상태 폴더 열기"
$openRootItem.Add_Click({ Open-Folder $InstallRoot })
$menu.Items.Add($openRootItem) | Out-Null

$openLogItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openLogItem.Text = "로그 폴더 열기"
$openLogItem.Add_Click({ Open-Folder $LogDir })
$menu.Items.Add($openLogItem) | Out-Null

$openQueueItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openQueueItem.Text = "전송 대기 큐 열기"
$openQueueItem.Add_Click({ Open-Folder $QueueDir })
$menu.Items.Add($openQueueItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$script:resyncTodayPrescriptionItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:resyncTodayPrescriptionItem.Text = "오늘 처방 전체 재전송 (덮어쓰기)"
$script:resyncTodayPrescriptionItem.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("오늘 처방 전체를 서버에 다시 전송합니다. 누락된 처방만 보내는 작업이 아닙니다.`r`n기존 처방 데이터를 덮어쓸 수 있으므로 관리자와 수집 결과를 먼저 확인하세요.`r`n`r`n전체 재전송을 실행하시겠습니까?", "PharmFarm Agent", "OKCancel", "Warning")
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
    [void](Request-TodayPrescriptionOverwrite)
    Start-Sleep -Milliseconds 500
    [void](Update-TrayStatus)
  }
})
$menu.Items.Add($script:resyncTodayPrescriptionItem) | Out-Null

$resyncControlledItem = New-Object System.Windows.Forms.ToolStripMenuItem
$resyncControlledItem.Text = "향정 후보 다시 동기화"
$resyncControlledItem.Add_Click({
  Request-ControlledDrugResync
  Start-Sleep -Milliseconds 500
  Update-TrayStatus
})
$menu.Items.Add($resyncControlledItem) | Out-Null

$resyncReferenceItem = New-Object System.Windows.Forms.ToolStripMenuItem
$resyncReferenceItem.Text = "참조 데이터 전체 다시 동기화"
$resyncReferenceItem.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("약품 마스터, 재고, 바코드, 가격, 단위, 향정 후보를 다시 검사합니다.`r`n데이터가 많으면 시간이 걸릴 수 있습니다.", "PharmFarm Agent", "OKCancel", "Information")
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
    Request-ReferenceResync
    Start-Sleep -Milliseconds 500
    Update-TrayStatus
  }
})
$menu.Items.Add($resyncReferenceItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$startItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startItem.Text = "에이전트 시작"
$startItem.Add_Click({ Start-AgentTask; Start-Sleep -Milliseconds 500; Update-TrayStatus })
$menu.Items.Add($startItem) | Out-Null

$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopItem.Text = "에이전트 중지"
$stopItem.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("에이전트를 중지하면 '에이전트 시작'을 누를 때까지 처방이 수집되지 않습니다.`r`nPC를 다시 켜도 중지가 유지되며 자동 복구하지 않습니다.`r`n정말 중지하시겠습니까?", "PharmFarm Agent", "OKCancel", "Warning")
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
    Stop-AgentTask
    Start-Sleep -Milliseconds 500
    [void](Update-TrayStatus)
  }
})
$menu.Items.Add($stopItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "트레이 아이콘 종료 (직접 다시 켤 때까지)"
$exitItem.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("트레이 아이콘과 재고 알림을 종료합니다. 처방 수집 에이전트는 계속 실행됩니다.`r`nPC를 다시 켜도 아이콘은 자동 복구하지 않습니다.`r`n다시 표시하려면 설치 폴더의 run-agent-tray.bat를 실행하세요.", "PharmFarm Agent", "OKCancel", "Warning")
  if ($answer -ne [System.Windows.Forms.DialogResult]::OK) { return }
  try {
    Set-PharmFarmPaused -InstallRoot $InstallRoot -Role "tray" -Paused $true
    [System.Windows.Forms.Application]::Exit()
  } catch {
    Show-Balloon "PharmFarm" "트레이 종료 설정을 저장하지 못했습니다. 관리자에게 문의해 주세요." "Error" 8000
  }
})
$menu.Items.Add($exitItem) | Out-Null

$script:notifyIcon.ContextMenuStrip = $menu
$script:notifyIcon.Add_DoubleClick({ Open-Folder $InstallRoot })

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 10000
$script:timer.Add_Tick({ Update-TrayStatus })
$script:timer.Start()

$script:showingStockAlert = $false
$script:alertTimer = New-Object System.Windows.Forms.Timer
$script:alertTimer.Interval = 1000
$script:alertTimer.Add_Tick({ Check-PrescriptionStockAlerts })
$script:alertTimer.Start()

$initialRuntimeState = Update-TrayStatus
if (Test-AgentRuntimeRunning $initialRuntimeState) {
  Show-Balloon "PharmFarm" "에이전트 프로세스가 실행 중입니다. 서버 연결과 처방 수집 결과는 관리자 화면에서 확인해 주세요." "Info" 5000
} elseif ($initialRuntimeState -in @("Paused", "Maintenance", "Unknown")) {
  Show-Balloon "PharmFarm" "$(Get-AgentRuntimeStateLabel $initialRuntimeState). 아이콘을 우클릭해 필요한 조치를 확인해 주세요." "Warning" 8000
} else {
  Show-Balloon "PharmFarm" "처방 수집 에이전트의 시작 상태를 확인 중입니다. 중지 상태면 자동으로 다시 시작합니다." "Info" 5000
}
[System.Windows.Forms.Application]::Run()
} catch {
  Write-Error "PharmFarm tray failed: $($_.Exception.Message)"
  exit 1
} finally {
  try {
    if ($null -ne $script:timer) { $script:timer.Stop(); $script:timer.Dispose() }
    if ($null -ne $script:alertTimer) { $script:alertTimer.Stop(); $script:alertTimer.Dispose() }
    if ($null -ne $script:notifyIcon) { $script:notifyIcon.Visible = $false; $script:notifyIcon.Dispose() }
    if ($script:ownsTrayIcon -and $null -ne $script:trayIcon) { $script:trayIcon.Dispose() }
    if ($null -ne $menu) { $menu.Dispose() }
  } finally {
    Exit-PharmFarmLock -Handle $trayRuntimeLock
  }
}
