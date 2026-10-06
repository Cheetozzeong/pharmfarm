# On-demand only. Never return raw log text, configuration, SQL, queues,
# prescription codes/hashes, patient data, computer/user names, or paths.
function Convert-PharmFarmDiagnosticEntry {
  param([string]$Line)
  if ($Line.Length -gt 2048) { return $null }
  $match = [regex]::Match($Line, '^\[?(?<at>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\]?\s+(?:\[(?<level>INFO|WARN|ERROR)\]\s+)?(?<body>.+)$')
  if (!$match.Success) { return $null }
  $at = [DateTimeOffset]::MinValue
  if (![DateTimeOffset]::TryParse($match.Groups['at'].Value, [ref]$at)) { return $null }
  $body = $match.Groups['body'].Value
  $event = 'OTHER'
  foreach ($rule in @(
    @('^prescription stock alert queued', 'ALERT_QUEUED'),
    @('^alert visible', 'ALERT_VISIBLE'), @('^alert acknowledged', 'ALERT_ACKNOWLEDGED'),
    @('^alert (display|timer|archive|invalid)', 'ALERT_ERROR'),
    @('^tray starting', 'TRAY_STARTED'), @('^(tray startup|status timer) failed', 'TRAY_ERROR'),
    @('^supervisor role=', 'SUPERVISOR_CHECK'), @('^supervisor stale', 'RUNTIME_STALLED'),
    @('^supervisor launch', 'RUNTIME_START'), @('^supervisor started', 'SUPERVISOR_STARTED'),
    @('^host started', 'HOST_STARTED'), @('^host exited', 'HOST_EXITED'),
    @('^child started', 'CHILD_STARTED'), @('^watch scan', 'WATCH_SCAN'),
    @('^queued prescription', 'PRESCRIPTION_QUEUED'), @('^queued cancellation', 'CANCELLATION_QUEUED'),
    @('^retry scheduled', 'SEND_RETRY'), @('^heartbeat', 'HEARTBEAT'),
    @('^remote command', 'REMOTE_COMMAND'), @('^remote update', 'REMOTE_UPDATE'),
    @('^(agent started|runtime lock|agent loop)', 'AGENT_RUNTIME')
  )) { if ($body -match $rule[0]) { $event = $rule[1]; break } }
  $level = $match.Groups['level'].Value
  if (!$level) { $level = if ($body -match 'failed|error|stale|invalid') { 'WARN' } else { 'INFO' } }
  # Unknown INFO text is not diagnostically useful. Unknown errors have ONLY
  # a fixed classification; blacklist-only redaction is not a privacy boundary.
  if ($event -eq 'OTHER' -and $level -eq 'INFO') { return $null }
  $issue = 'NONE'
  if ($body -match 'lastError|PropertyNotFound|PropertyAssignment') { $issue = 'PROPERTY_MISSING' }
  elseif ($body -match 'SQL|SqlException|SqlClient') { $issue = 'SQL' }
  elseif ($body -match 'timed?\s*out|timeout|시간.*초과') { $issue = 'TIMEOUT' }
  elseif ($body -match 'denied|Unauthorized|권한|액세스') { $issue = 'ACCESS_DENIED' }
  elseif ($body -match 'network|connection|연결|connect|HttpRequest|WebException') { $issue = 'CONNECTION' }
  elseif ($event -in @('ALERT_ERROR','TRAY_ERROR')) { $issue = 'UI' }
  elseif ($level -in @('WARN','ERROR')) { $issue = 'OTHER_ERROR' }
  $metrics = [ordered]@{}
  if ($event -ne 'OTHER') {
    foreach ($key in @('rows','files','pid','hostPid','childPid','attempts','delay','exitCode','httpStatus','drugs','tracked','pending','queued','skipped','baselined')) {
      $number = [regex]::Match($body, '(?:^|\s)' + $key + '=(?<n>-?\d{1,9})(?:\s|$)')
      if ($number.Success) { $metrics[$key] = [long]$number.Groups['n'].Value }
    }
  }
  $roleMatch = [regex]::Match($body, '(?:^|\s)role=(agent|tray|supervisor|watchdog)(?:\s|$)')
  $role = if ($roleMatch.Success -and $event -ne 'OTHER') { $roleMatch.Groups[1].Value } else { 'unknown' }
  $stateMatch = [regex]::Match($body, '(?:^|\s)state=(?<state>[a-z-]+)(?::[a-zA-Z]+)?(?:\s|$)')
  $state = 'unknown'
  if ($event -eq 'SUPERVISOR_CHECK' -and $stateMatch.Success -and $stateMatch.Groups['state'].Value -in @('running','running-progress-unavailable','suppressed','busy','start-requested','retry-limited','stale-confirming','stale-restart-requested','stale-retry-limited','stale-identity-unverified','inspection-failed','stop-unconfirmed')) {
    $state = $stateMatch.Groups['state'].Value
  }
  if ($event -in @('HEARTBEAT','REMOTE_COMMAND')) {
    $http = [regex]::Match($body, '(?:status=|httpStatus=|endpoint returned )(?<n>[1-5]\d{2})(?:\D|$)')
    if ($http.Success) { $metrics['httpStatus'] = [int]$http.Groups['n'].Value }
  }
  return [ordered]@{ at = $at.ToString('o'); level = $level; event = $event; issue = $issue; role = $role; state = $state; metrics = $metrics }
}

function Read-PharmFarmDiagnosticTail {
  param([string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $length = [Math]::Min(32768, $stream.Length)
    [void]$stream.Seek(-$length, [IO.SeekOrigin]::End)
    $bytes = New-Object byte[] $length
    $read = $stream.Read($bytes, 0, $bytes.Length)
    $text = [Text.Encoding]::UTF8.GetString($bytes, 0, $read)
    if ($stream.Length -gt $length) {
      $firstNewline = $text.IndexOf("`n")
      $text = if ($firstNewline -ge 0) { $text.Substring($firstNewline + 1) } else { '' }
    }
    return @($text -split '\r?\n' | Select-Object -Last 120)
  } finally { $stream.Dispose() }
}

function Get-PharmFarmDiagnostics {
  param([string]$InstallRoot, [string]$AgentVersion, [int]$Hours = 24)
  $ErrorActionPreference = 'Stop'
  $hours = [Math]::Max(1, [Math]::Min(48, $Hours))
  $now = [DateTimeOffset]::Now
  $since = $now.AddHours(-$hours)
  $runtime = @()
  foreach ($role in @('agent','tray','supervisor')) {
    $age = $null
    $path = Join-Path $InstallRoot ("lifecycle/$role.progress")
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $age = [Math]::Max(0, [long]($now.UtcDateTime - (Get-Item -LiteralPath $path).LastWriteTimeUtc).TotalSeconds)
    }
    $runtime += [ordered]@{
      role = $role; running = (Test-PharmFarmRuntimeLocked -InstallRoot $InstallRoot -Role $role)
      paused = (Test-Path -LiteralPath (Join-Path $InstallRoot ("lifecycle/$role.paused.json")))
      progressAgeSeconds = $age
    }
  }
  $counts = [ordered]@{}
  foreach ($folder in @('queue','dead-letter','ui-alerts','ui-alerts-failed')) {
    $path = Join-Path $InstallRoot $folder
    $counts[$folder] = @(Get-ChildItem -LiteralPath $path -Filter '*.json' -File -ErrorAction SilentlyContinue).Count
  }
  $files = @(); $total = 0
  $paths = @(Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'logs') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(agent|tray|launcher|update)-\d{8}\.log$' -and $_.LastWriteTime -ge $since.DateTime -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 16)
  foreach ($file in $paths) {
    if ($total -ge 500) { break }
    $entries = @(); $omitted = 0; $available = $true
    try {
      foreach ($line in @(Read-PharmFarmDiagnosticTail -Path $file.FullName)) {
        $entry = Convert-PharmFarmDiagnosticEntry $line
        if ($null -ne $entry -and [DateTimeOffset]::Parse($entry.at) -ge $since -and [DateTimeOffset]::Parse($entry.at) -le $now) { $entries += $entry }
        else { $omitted++ }
      }
      $entries = @($entries | Select-Object -Last ([Math]::Min(120, 500 - $total)))
    } catch { $available = $false }
    $total += $entries.Count
    $files += [ordered]@{ name = $file.Name; available = $available; entries = $entries; omittedLines = $omitted }
  }
  $report = [ordered]@{
    schemaVersion = 1; capturedAt = $now.ToString('o'); agentVersion = $AgentVersion; hours = $hours
    privacy = 'STRUCTURED_ALLOWLIST'; runtime = $runtime; counts = $counts; files = $files
    maintenance = (Test-Path -LiteralPath (Join-Path $InstallRoot 'lifecycle/maintenance.json'))
    disabled = (Test-Path -LiteralPath (Join-Path $InstallRoot 'lifecycle/disabled.json'))
  }
  # Hard bound on the actual outgoing JSON, not just the input tail size.
  while ([Text.Encoding]::UTF8.GetByteCount(($report | ConvertTo-Json -Depth 12 -Compress)) -gt 131072 -and $report.files.Count -gt 0) {
    $report.files = @($report.files | Select-Object -SkipLast 1)
  }
  return $report
}
