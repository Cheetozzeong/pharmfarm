# Windows agent recovery patch: 1.4.0-ps

## Scope

Local patch for independent watchdog recovery, login/periodic restart, consistent task settings, singleton execution and durable stop/maintenance controls. No CMS/backend changes, automatic full-overwrite resync, SQL identity migration or pre-login Windows service.

## Customer installation result — 2026-09-15 13:42 KST

- Production code commits: `8017c1a` and repair compatibility fix `bddf494`, pushed to `main` through the existing Vercel Git integration. Customer downloaded from `/agent`; no direct file transfer or backend deployment was used.
- First repair stopped safely before copying runtime files: ending the not-yet-existing watchdog task emitted native stderr, which Windows PowerShell treats as an error under `Stop`. The fix scopes `Continue` to the best-effort native task-end call and retains mandatory exact-process/lock verification afterward. Added regression tests; lifecycle 175 + tray 80 + update 107 = 362 assertions passed locally.
- Final package: 104,692 bytes, SHA256 `cfb878fab6d2f8c1eb8d80588acf297b6c3910f46379ff8baa29a75fbf69c4b8`. Production download hash matched. Installed lifecycle helper hash matched local source: `23eadb36b27aa299687adac2ce283d8957685fdd2750e1de7342d31291652306`.
- Repair completed at approximately 13:38:50; all three scheduled tasks were registered and read back. `agent.repair-report.json` reported settings/config/manual-pauses preserved and a backup under `C:\ProgramData\PharmFarmAgent\backups\20260915-133849-*`.
- Windows inventory confirmed exactly one installed collector and one installed tray process. Both scheduled tasks were Running. Watchdog was Ready with LastTaskResult 0; successive 13:39 and 13:40 checks reported both targets running and the next minute scheduled.
- CMS showed `1.4.0-ps` online, last heartbeat 13:40, SQL/API normal at 13:41, and queue 0. The pre-existing status command completed. No new backfill/overwrite command was issued.
- Diagnostic and completed repair consoles were closed; normal collection/tray remained active. A prescription-stock alert was left unacknowledged for pharmacy staff. Remote control ended before 13:50.
- No backend files were changed; `Aidit/scripts/pharmfarm` deployment was not required or run. No reboot/logout, crash-injection, or manual-pause live test was performed. Those scenarios remain unverified on this PC; the original shutdown cause is still not established.

The preparation record below describes the original pre-window artifact, not the final compatibility-fix package.

## Prepared artifact and local results

Prepared on 2026-09-15 before the customer window. Customer PC has not been controlled or modified during this preparation.

- Runtime version: `1.4.0-ps`.
- Package: `public/pharmfarm-agent-production.zip` (104,522 bytes, 26 files).
- SHA256: `2dfc07bb43b983811488eb248b3629fe137bdb4fe04fca9c134d538f60b82d52`.
- PowerShell 7.6.6 on macOS: lifecycle 173 + tray 80 + update 107 = 360 passing assertions, including parsing the production PowerShell scripts.
- ZIP integrity passed; all 26 files match the source byte-for-byte. Runtime PowerShell encoding checked, test fixtures excluded, and `dist/pharmfarm-agent-production.zip` matches the package.
- `npm run build` and `git diff --check` passed. Vite reports a non-blocking bundle-size warning; the web application was not deployed.
- Windows 5.1 / Task Scheduler / WinForms / SQL / CMS runtime checks are still pending. This is a locally tested patch, not an already verified customer installation.

## Customer window — 2026-09-15, Asia/Seoul

- Follow-up authorization: the user requested pushing this patch to `main` for the existing Vercel Git deployment. Obtain the package from the production `/agent` page on the customer PC; direct remote file upload is unnecessary. This supersedes the earlier no-public-deployment restriction for this patch only. It does not extend the 14:00 customer-control deadline.
- No customer PC control before 13:15 or after 14:00.
- From 13:50, do not begin another installation, process-stop test or other disruptive operation. Finish checking and safely hand back the PC.
- Only use a complete locally tested package. If preparation, access, identity or approval is missing, report the blocker and do not improvise a live patch.
- Do not reboot, log out, publicly deploy the package or invoke prescription overwrite/backfill in this window without additional user authorization.

## Apply and verify

1. Confirm the remote target is the intended pharmacy and the installed Windows user is the original agent account. Record the current CMS heartbeat, installed version, task identity and process status without exposing credentials.
2. Transfer/extract the full package through an available authorized channel to a folder outside ProgramData. A new download alone does not update an installed copy.
   Verify remote keyboard input before submitting commands; prior remote paste/typing was unreliable. Prefer the complete package and its launcher over typing a long PowerShell command.
3. Run `repair-pharmfarm-agent.bat`, not the new-install settings wizard. It preserves configuration/collection state, backs up the old runtime and task definitions, suppresses recovery while copying and validates all three registered tasks.
4. Check the backup path/result. On failure, inspect the reported rollback result and maintenance state; do not clear pause/maintenance files to force a start.
5. Confirm `PharmFarmAgent`, `PharmFarmAgentTray`, and `PharmFarmAgentWatchdog` use the original user's InteractiveToken. Agent/tray have no execution time limit; the one-shot watchdog has a two-minute limit and a repeating one-minute time trigger with no end date.
6. Confirm a single collector and a single tray process, agent version `1.4.0-ps`, a fresh watchdog state and a new CMS heartbeat. Distinguish normal collection and API health from process liveness.
7. If time and the customer's current usage permit, briefly stop the exact collector/tray processes without using the intentional Stop action and confirm independent recovery on the next scheduled check. Do not kill unrelated agents or interrupt an active resync. Do not claim reboot/resume validation from this test.
8. Test an intentional Stop only when safe: verify it remains stopped across watchdog checks, then explicitly Start and verify CMS heartbeat again. Restore tray visibility before handoff.
9. Leave normal collection running unless the user had intentionally paused it. Summarize installed version, checks performed, any untested Windows scenarios and unresolved errors by 14:00.

## Local validation boundaries

PowerShell AST checks and isolated process/control-file tests run on macOS, including failure-path mocks. These do not establish Windows 5.1 COM scheduler registration, WinForms behavior, SQL integrated authentication, antivirus compatibility, or reboot/sleep behavior. The Windows checks above remain required; full reboot/resume testing needs a separately authorized window.

Run the local regression suites from the repository root with PowerShell (no Pester dependency):

```powershell
pwsh -NoProfile -File tests/windows-agent-lifecycle.Tests.ps1
pwsh -NoProfile -File tests/windows-agent-tray.Tests.ps1
pwsh -NoProfile -File tests/windows-agent-update.Tests.ps1
```

The lifecycle suite uses actual separate PowerShell processes to check retained locks and crash release, plus mocked Windows inventory/watchdog scenarios. The tray suite extracts event functions without creating WinForms or sending data. The update suite uses temporary fixtures for backup, byte-preservation, rollback and injected registration/stop failures; it does not register tasks on the host.
