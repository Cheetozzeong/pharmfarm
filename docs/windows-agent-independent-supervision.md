# Agent 1.4.2: independent recovery

## Why

The September 16 investigation found a stopped Windows Schedule service (exit 1067).
System events recorded unexpected Task Scheduler exits at 08:59:41, 09:03:30 and
09:11:27; Application Error reported `svchost.exe_BITS` / `combase.dll` at 09:11:27.
The last watchdog check was 09:11:04 and collector activity ended at 09:12:01.
This establishes why scheduled recovery was unavailable, **not** a proven direct
cause of collector exit. Task operational logging was disabled; no host exit log
existed. Do not claim the old launcher was conclusively exonerated.

## Runtime and load

- `PharmFarm-AgentHost.exe -Role supervisor`: a GUI executable, not a PowerShell loop.
  Checks two local role locks/intent files every 10 seconds. Does not query SQL,
  send HTTP, invoke WMI, or start another process while healthy.
- The installed user's `PharmFarmAgentSupervisor.lnk` in Startup is independent
  of Task Scheduler. Windows may delay Startup launches; this is a login trigger,
  **not** pre-login boot collection.
- Existing agent/tray tasks remain. Native watchdog ticks do not spawn PowerShell.
  A missing supervisor is started with `CREATE_BREAKAWAY_FROM_JOB`. If Scheduler
  forbids direct breakaway, local WMI creates a suspended, windowless child outside
  that Job. Its Windows SID, session and elevation must match the caller before
  the only thread is resumed. A failed check terminates that suspended child.
  No WMI/service security settings are changed; Startup/manual launch remains
  available independently of the broker. Healthy checks do not invoke WMI.
- Installer bootstrap uses the existing least-privilege task identity. No service,
  new account, credential storage, elevation bypass, or security exclusion is added.
- Manual installed-host double-click resumes the tray and attempts independent
  supervisor start. Collector pause remains paused until explicit Start.
- Each healthy check writes one tiny supervisor timestamp. Collector progress is
  throttled to at most one small atomic write every five seconds, on actual work.
  Launcher logs record transitions/exits, not every healthy check; daily log chunks
  are capped at roughly 2 MiB plus one preceding chunk. No clinical payloads.

## Recovery policy

1. Respect disabled, maintenance and per-role manual pause markers.
2. Missing role lock: reserve a persistent retry budget, then start the hidden host.
   The real runtime also acquires its singleton and performs legacy identity checks.
3. Healthy role lock: do nothing. API/SQL failures alone never authorize termination.
4. Collector progress older than 15 minutes: require the same sample for another
   60 seconds. Resume gaps reset confirmation. Missing, corrupt or future progress
   cannot authorize a kill.
5. Before stale restart: bind a process handle, verify start time, native PowerShell
   executable and exact installed regular collector command through WMI, and
   re-read controls/progress under the lifecycle gate. Never kill a foreign script,
   unverified process, manual resync, or reused PID.
6. Maximum 3 attempts/role/15 minutes, at least 60 seconds apart. Persisted ledger
   survives supervisor restarts. Corrupt ledger/clock rollback fails closed.

Update/rollback/uninstall includes the supervisor and Startup shortcut. Repair
preserves config bytes, queues, sent data, sync hashes, manual pauses and logs.
No automatic overwrite or backfill is introduced.

## CMS scope

The existing backend already stores agent heartbeat timestamps. CMS now refreshes
the agent control page every 30 seconds (5 seconds while commands are active),
pauses network refresh in hidden tabs, and refreshes on return. Timestamp parsing
explicitly treats API timezone-less values as Korean server time. A local UI clock
expires a stale green badge even when fetching fails. The selected device receives
an actionable connection warning explaining that queued commands cannot start a
dead PC process. This is **CMS-open monitoring only**, not an unattended server-side
incident recorder, business-hours detector, email or Slack alert. No BE changes.

## Validation / release gate

- Local policy, transaction, tray, syntax, native argument/PE and CMS timestamp tests.
- Windows PowerShell 5.1 tests run in `.github/workflows/windows-agent.yml`.
- Isolated native fixture tests: no windows, single instance, dead collector
  recovery without scheduling, pause/maintenance, supervisor death with surviving
  children, real temporary Scheduler task breakaway, and exact-identity stalled
  collector recovery. No production tasks/data or OS services are stopped.
- CI records idle supervisor CPU and working set. These are test-runner measurements,
  not a customer-PC performance guarantee or a desktop visual flashing test.
- Do not publish the new ZIP to main until native Windows tests pass. Customer
  update remains user-operated, with follow-up CMS/SQL/API and visual verification.
- The affected PC's Schedule service crash still needs separate authorized OS
  diagnosis/restoration **before repair can run**. Do not automatically change
  that shared service or run OS repairs during pharmacy work.

## Verified build (September 16)

Windows Server 2022 / Windows PowerShell 5.1 [native verification passed](https://github.com/Cheetozzeong/pharmfarm/actions/runs/35074202522):
244 policy/update/tray/windowless assertions, 6 host lifetime assertions and 13
independent-supervisor assertions. Idle supervisor measured 15.7 MiB working set
and 0.0 ms CPU over 22 seconds (measurement resolution, not literally zero cost).
The package contains the same native binary exercised in that run. Additional
heartbeat recovery regression tests exercise retry after a temporary 404.

Local validation: 426 PowerShell assertions, 2 CMS timestamp tests, TypeScript
and production Vite build. Real customer Windows 10 desktop/reboot verification
has **not** been performed; OS repair and customer update remain separate steps.

Sources: [process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags),
[local process creation](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process),
[login startup](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys).
