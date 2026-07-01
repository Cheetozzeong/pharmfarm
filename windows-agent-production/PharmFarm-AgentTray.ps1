$ErrorActionPreference = "Continue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppName = "PharmFarmAgent"
$TaskName = "PharmFarmAgent"
$InstallRoot = Join-Path $env:ProgramData $AppName
$AgentScript = Join-Path $InstallRoot "PharmFarm-Agent.ps1"
$ConfigFile = Join-Path $InstallRoot "agent.config.json"
$StateFile = Join-Path $InstallRoot "agent.state.json"
$LogDir = Join-Path $InstallRoot "logs"
$QueueDir = Join-Path $InstallRoot "queue"
$SentDir = Join-Path $InstallRoot "sent"
$DeadDir = Join-Path $InstallRoot "dead-letter"
$BootstrapStateFile = Join-Path $InstallRoot "bootstrap.state.json"
$SyncStateDir = Join-Path $InstallRoot "sync-state"

function Ensure-Directory {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) {
    [void](New-Item -ItemType Directory -Force -Path $Path)
  }
}

function Read-State {
  if (!(Test-Path -LiteralPath $StateFile)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
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
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
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

function Open-Folder {
  param([string]$Path)
  Ensure-Directory $Path
  Start-Process explorer.exe $Path
}

function Start-AgentTask {
  try {
    Start-ScheduledTask -TaskName $TaskName
    Show-Balloon "PharmFarm" "에이전트 시작을 요청했습니다."
  } catch {
    Show-Balloon "PharmFarm" "에이전트를 시작하지 못했습니다."
  }
}

function Stop-AgentTask {
  try {
    Stop-ScheduledTask -TaskName $TaskName
    Show-Balloon "PharmFarm" "에이전트 중지를 요청했습니다."
  } catch {
    Show-Balloon "PharmFarm" "에이전트를 중지하지 못했습니다."
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

  [void](Write-JsonFile -Path $BootstrapStateFile -Value $state -Depth 8)
}

function Remove-SyncHash {
  param([string]$Kind)

  $path = Join-Path $SyncStateDir ("{0}.hashes.json" -f $Kind)
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Restart-AgentTask {
  try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700
    Start-ScheduledTask -TaskName $TaskName
    return $true
  } catch {
    return $false
  }
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
    Show-Balloon "PharmFarm" "에이전트 파일을 찾지 못했습니다."
    return
  }

  $psExe = Get-PowerShellExe
  if (!(Test-Path -LiteralPath $psExe)) {
    Show-Balloon "PharmFarm" "Windows PowerShell을 찾지 못했습니다."
    return
  }

  try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700

    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentScript`" -ResyncTodayPrescriptions -ConfigPath `"$ConfigFile`""
    $process = Start-Process -FilePath $psExe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru

    if ($process.ExitCode -eq 0) {
      Show-Balloon "PharmFarm" "금일 처방 재수집을 요청했습니다."
    } else {
      Show-Balloon "PharmFarm" "금일 처방 재수집이 실패했습니다. 로그를 확인하세요."
    }
  } catch {
    Show-Balloon "PharmFarm" "금일 처방 재수집을 시작하지 못했습니다."
  } finally {
    [void](Restart-AgentTask)
  }
}

function Request-ReferenceResync {
  Ensure-Directory $SyncStateDir
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700

  foreach ($kind in @("drug-master", "stock", "barcode", "wholesaler", "controlled-drug", "controlled-drug-product-info", "controlled-drug-master", "drug-price", "drug-unit")) {
    Remove-SyncHash $kind
  }

  if (Test-Path -LiteralPath $BootstrapStateFile) {
    Remove-Item -LiteralPath $BootstrapStateFile -Force -ErrorAction SilentlyContinue
  }

  if (Restart-AgentTask) {
    Show-Balloon "PharmFarm" "참조 데이터 전체 재동기화를 시작했습니다."
  } else {
    Show-Balloon "PharmFarm" "재동기화 시작에 실패했습니다."
  }
}

function Request-ControlledDrugResync {
  Ensure-Directory $SyncStateDir
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700

  Remove-SyncHash "controlled-drug"
  Remove-SyncHash "controlled-drug-product-info"
  Remove-SyncHash "controlled-drug-master"
  Reset-BootstrapFlags @("controlledDrugReferenceCompleted", "controlledDrugProductInfoCompleted", "controlledDrugCompleted", "controlledDrugMasterCompleted")

  if (Restart-AgentTask) {
    Show-Balloon "PharmFarm" "향정 후보 재동기화를 시작했습니다."
  } else {
    Show-Balloon "PharmFarm" "향정 후보 재동기화 시작에 실패했습니다."
  }
}

function Show-Balloon {
  param(
    [string]$Title,
    [string]$Text
  )

  $script:notifyIcon.BalloonTipTitle = $Title
  $script:notifyIcon.BalloonTipText = $Text
  $script:notifyIcon.ShowBalloonTip(2500)
}

function Update-TrayStatus {
  $state = Read-State
  $taskState = Get-AgentTaskState
  $queueCount = Get-QueueCount
  $status = "대기 중"
  $message = "상태 파일을 기다리는 중"

  if ($null -ne $state) {
    $status = if ($state.status) { $state.status.ToString() } else { "UNKNOWN" }
    $message = if ($state.message) { $state.message.ToString() } else { "상태 메시지 없음" }
  }

  if ($taskState -eq "Running") {
    $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
  } elseif ($taskState -eq "Ready") {
    $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
  } else {
    $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
  }

  $tooltip = "PharmFarm 실행 중 · $taskState · 대기 $queueCount"
  if ($tooltip.Length -gt 63) {
    $tooltip = $tooltip.Substring(0, 63)
  }
  $script:notifyIcon.Text = $tooltip

  $script:statusItem.Text = "상태: $status / 작업: $taskState / 대기: $queueCount"
  $script:messageItem.Text = "최근: $message"
}

Ensure-Directory $InstallRoot
Ensure-Directory $LogDir
Ensure-Directory $QueueDir
Ensure-Directory $SentDir
Ensure-Directory $DeadDir

$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$script:notifyIcon.Text = "PharmFarm 실행 중"
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

$resyncTodayPrescriptionItem = New-Object System.Windows.Forms.ToolStripMenuItem
$resyncTodayPrescriptionItem.Text = "금일 처방 다시 가져오기"
$resyncTodayPrescriptionItem.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("오늘 등록된 처방 라인을 다시 수집해 서버에 덮어쓰기 요청으로 전송합니다.`r`n아직 상태 변경을 하지 않은 테스트 환경에서만 사용하세요.", "PharmFarm Agent", "OKCancel", "Information")
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
    Request-TodayPrescriptionOverwrite
    Start-Sleep -Milliseconds 500
    Update-TrayStatus
  }
})
$menu.Items.Add($resyncTodayPrescriptionItem) | Out-Null

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
$stopItem.Add_Click({ Stop-AgentTask; Start-Sleep -Milliseconds 500; Update-TrayStatus })
$menu.Items.Add($stopItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "트레이 아이콘 종료"
$exitItem.Add_Click({
  $script:timer.Stop()
  $script:notifyIcon.Visible = $false
  $script:notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($exitItem) | Out-Null

$script:notifyIcon.ContextMenuStrip = $menu
$script:notifyIcon.Add_DoubleClick({ Open-Folder $InstallRoot })

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 10000
$script:timer.Add_Tick({ Update-TrayStatus })
$script:timer.Start()

Update-TrayStatus
Show-Balloon "PharmFarm" "PharmFarm 에이전트가 실행 중입니다."
[System.Windows.Forms.Application]::Run()
