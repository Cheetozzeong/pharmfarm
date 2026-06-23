$ErrorActionPreference = "Continue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppName = "PharmFarmAgent"
$TaskName = "PharmFarmAgent"
$InstallRoot = Join-Path $env:ProgramData $AppName
$StateFile = Join-Path $InstallRoot "agent.state.json"
$LogDir = Join-Path $InstallRoot "logs"
$QueueDir = Join-Path $InstallRoot "queue"
$SentDir = Join-Path $InstallRoot "sent"
$DeadDir = Join-Path $InstallRoot "dead-letter"

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
