# Agent 1.4.1-ps — windowless background launch

## What changes

The 1.4.0 watchdog started a console-subsystem `powershell.exe` every minute. Its `-WindowStyle Hidden` flag can hide the window only after creation. Version 1.4.1 uses the bundled `PharmFarm-AgentHost.exe`, a deterministic AnyCPU .NET Framework 4.6.2 Windows GUI executable, for all three scheduled tasks. The host uses `CREATE_NO_WINDOW | CREATE_SUSPENDED`, assigns the primary child to a Job, and resumes it only after assignment succeeds. It preserves the same logged-in Windows user and propagates the child's exit code to Task Scheduler.

The Job uses kill-on-close so Scheduler end/timeout cannot leave its primary PowerShell orphaned. Silent breakaway is deliberate: an independent collector launched by watchdog fallback must survive watchdog completion; its own host creates a separate lifetime Job. Existing runtime locks, absent-process checks, durable pause, disabled and maintenance markers are unchanged. A launcher alone never counts as a healthy collector.

Covered paths: login starts, periodic watchdog starts, watchdog fallback, tray fallback/restart, explicitly requested tray resync, and native scheduler support commands. Support commands use `UseShellExecute=false` / `CreateNoWindow=true` and asynchronously capture both output streams with a timeout. Intentional installation/repair/uninstall/debug batch consoles still display results and are never scheduled. `explorer.exe` opens folders only on explicit user action.

## Updating the customer PC (user-operated)

1. Download the complete **1.4.1-ps** package from `/agent`; extract outside `C:\ProgramData\PharmFarmAgent`.
2. As the original installation user, run `repair-pharmfarm-agent.bat`. Do not copy just the collector script; the executable and three task actions must change together.
3. The launcher first runs a harmless hidden `exit 0` self-test before any old tasks/data are changed. If blocked by security software, stop and inspect package `logs\launcher-YYYYMMDD.log`; do not bypass security protections.
4. Wait for `Repair complete`. Existing settings/device identity, queues, logs and manual pauses are preserved with backup. Normal collection resumes unless deliberately paused; no forced backfill/overwrite is added.
5. Confirm CMS **1.4.1-ps**, recent heartbeat, SQL/API health. Observe at least three minute boundaries for flashing. Check `watchdog.state.json`: an already-running agent should say `running`, not repeatedly `restarted`.
6. On an approved test window, verify an actual crash recovers and intentional Stop remains stopped; then explicitly resume. Do not reboot or stop active collection without coordination.

For a console-free manual tray resume, double-click the **installed** `C:\ProgramData\PharmFarmAgent\PharmFarm-AgentHost.exe`. `run-agent-tray.bat` is retained for compatibility but manually opening a batch file itself can show a command window.

Requires Windows 10+ with .NET Framework 4.6.2+. No SDK/compiler, VBScript, new account or Windows service is installed. The executable is not code-signed; organization application-control policy can block it. Preflight detects launch failure before taking the old installation down. No backend changes or separate BE deployment are needed.

## Build and verification

Local release checks: **396 assertions passed** (lifecycle 175, tray 80, update 109, windowless 32); TypeScript/Vite build passed with the pre-existing bundle-size warning. ZIP integrity and all 28 source-file byte comparisons passed. Two independent builds produced the same GUI launcher SHA256 `1125e9e183d25bb8f1966ff636f184ce5d6181287f67631030cedfb245e9702e`. Release ZIP SHA256: `0ef0fa102620c2d5449fbb3f29afab8ea77327c92b66e2d65223b144fe1fc957`.

Build with PowerShell 7/Roslyn plus Microsoft's NuGet `Microsoft.NETFramework.ReferenceAssemblies.net462` **1.0.3**. Reference package SHA256: `ee692a845743500910855d4c330ca6e9ef87c16e16f740e4474d187185d66e21`.

```powershell
pwsh -NoProfile -File scripts/build-agent-host.ps1 -ReferenceDirectory <extracted-package>/build/.NETFramework/v4.6.2
pwsh -NoProfile -File tests/windows-agent-lifecycle.Tests.ps1
pwsh -NoProfile -File tests/windows-agent-tray.Tests.ps1
pwsh -NoProfile -File tests/windows-agent-update.Tests.ps1
pwsh -NoProfile -File tests/windows-agent-windowless.Tests.ps1
```

Local tests cover process/lock recovery, no-op when running, pause/maintenance behavior, legacy-to-GUI task migration, rollback, launcher PE GUI/AnyCPU attributes, restricted argument routing, native output/exit/timeout, launcher inventory and preflight failure. Build twice and compare SHA256 for reproducibility. The C# source and executable ship in the package; the build script and tests stay in the repository.

`tests/windows-agent-host-integration.Tests.ps1` is a Windows-only isolated fixture suite for real no-window process launch, exit codes, primary-child cleanup and recovered-child lifetime. It uses a unique temporary directory with fake scripts and does not query real pharmacy configuration, register tasks or contact SQL/API. **It has not been run in the macOS development environment.** Customer desktop visual verification and Windows integration remain outstanding; source/PE checks are not a claim that a live Windows test passed.

Implementation references: [Microsoft process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags), [Job Objects and breakaway semantics](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [PowerShell hidden-window flash report](https://github.com/microsoft/terminal/issues/249).
