PharmFarm Production Agent

Target:
- Windows only
- No Git, Node, or npm required on the pharmacy PC
- Uses Windows PowerShell and Scheduled Task

Files:

1. install-pharmfarm-agent.bat
   Opens the setup wizard.
   The wizard copies the runtime package to ProgramData and verifies all three Scheduled Tasks.

2. PharmFarm-Agent.ps1
   Production-oriented local agent.
   Reads EPharm SQL Server with SELECT only.
   Queues data locally before sending it to the API.

3. PharmFarm-AgentTray.ps1
   Shows a PharmFarm status icon in the Windows tray area.
   The installer registers it as PharmFarmAgentTray.

4. PharmFarm-Agent.ico
   PharmFarm mascot icon used by the tray process, setup wizard, and Startup shortcuts.

5. run-agent-console.bat
   Runs the agent in a visible console for troubleshooting.

6. resync-today-prescriptions.bat
   Runs a one-time test sync for today's prescription rows.
   It sends overwriteExisting=true so the server can replace already imported prescription lines.

7. uninstall-pharmfarm-agent.bat
   Disables recovery first, stops the three exact PharmFarm processes, and removes their tasks/shortcuts.
   Runtime queue/log files remain in ProgramData for recovery/audit.

8. repair-pharmfarm-agent.bat
   Updates an existing installation without rewriting agent.config.json or collection state.
   Run from a newly extracted package, using the original installation's Windows account.

9. PharmFarm-AgentWatchdog.ps1 / PharmFarm-AgentLifecycle.ps1 / PharmFarm-AgentTasks.ps1
   Independent periodic recovery, shared process/control locks, and common scheduler definitions.

10. run-agent-tray.bat
    Explicitly restores a tray icon that the user intentionally closed.

Runtime path:

  C:\ProgramData\PharmFarmAgent

Runtime folders:

  queue       Pending events waiting to be sent
  sent        Successfully sent events
  dead-letter Payload errors that should not be retried
  logs        Daily log files
  sync-state  Local row hashes used to send only changed reference rows and changed prescription snapshots
  ui-alerts   Pending prescription stock alerts waiting for the signed-in user
  ui-alerts-shown  Prescription stock alerts acknowledged by the user

Runtime state files:

  agent.state.json          Local status shown by the tray icon
  agent.command-state.json  Recently handled remote commands, used to avoid duplicate execution
  watchdog.state.json       Last watchdog check and per-process result (not SQL/API health)
  lifecycle                 Singleton locks, durable user pauses, maintenance/uninstall markers
  backups                   Timestamped runtime/task backups made before setup or repair

Default SQL Server:

  .\EPHARM_DB

Default API:

  https://api.solusi.co.kr/api/v1/pharmfarm

Security defaults:

- The agent does not write to the pharmacy SQL database.
- The agent does not send raw QR text by default.
- The original prescription code is hashed before transmission.
- Patient name, phone, address, resident number are not collected.
- Network failures are retried from the local queue.

Prescription substitution rows:

- EPharm prsdrug.pd_extype is sent with every prescription line when present.
- pd_extype=1 means the original line that was substituted out.
- pd_extype=2 means the actual replacement line that was dispensed.
- pd_extype=9 means the low-price substitution surcharge line.
- The server should preserve all prescription lines for detail display, but only pd_extype=0 or pd_extype=2 rows should affect stock deduction. pd_extype=1 and pd_extype=9 are preserved without stock deduction, failure, or shortage creation.
- If an older local DB does not expose pd_extype/pd_exrow/pd_element, the agent sends the prescription line as a normal row.
- Live prescription watching stores a local snapshot hash per prescription in sync-state\prescription-live.hashes.json.
- If an already-seen prescription's PRESCRIPT_EDB/prsdrug snapshot changes later, the agent sends it again with syncMode=LIVE and overwriteExisting=true so the server can replace the stored prescription lines.
- The recent prescription watch window defaults to 32 rows. Add prescriptionScanRows to agent.config.json to adjust it; values are clamped between 8 and 500.
- The agent also rescans all of today's prescriptions every 5 minutes by default. Set prescriptionFullScanIntervalMinutes to 0 to disable it, or 1-1440 to adjust the interval.

Prescription stock alert:

- Agent version 1.3.2-ps reads stockAlerts returned by POST /agent/prescriptions.
- The server must set stockSource=PHARMFARM_SERVICE. Alerts from any other stock source are ignored.
- Successful prescriptions with no shortage or low-stock row do not show a popup.
- The agent decodes prescription API responses directly as UTF-8 so Korean drug names remain readable on Windows PowerShell 5.1.
- A centered, top-most window lists each prescription row whose shortageQuantity is greater than zero or whose stockAfterQuantity is less than 1.
- The popup shows prescription row, drug name, requested quantity, service stock before/after deduction, shortage quantity, and match status.
- The popup uses the PharmFarm ivory/green palette. Red and amber are limited to shortage and low-stock values instead of filling the entire row.
- Pending alerts remain in C:\ProgramData\PharmFarmAgent\ui-alerts until the signed-in user acknowledges them.
- Closing the tray icon prevents UI display, but does not discard pending alerts. They are shown after the tray process starts again.

Remote web commands:

- Agent version 1.3.2-ps can poll the PharmFarm API for remote commands.
- Default polling: GET /agent/commands?limit=5 every 30 seconds.
- The request includes the existing agent headers: X-PharmFarm-Agent-Version, X-PharmFarm-Device-Id, X-PharmFarm-Pharmacy-Id, and HMAC headers when agentSecret is configured.
- The server may return an array, or an object with commands/items/data.
- Each command must include commandId or id, and type or commandType.
- The agent posts STARTED, COMPLETED, FAILED, or REJECTED to POST /agent/commands/{commandId}/result.
- If the command endpoint returns 404, command polling is disabled until the agent restarts. This allows deploying the agent before the backend endpoint is available without repeated log noise.
- Duplicate commandId values are not executed twice. The agent stores the final local result in agent.command-state.json and replays the result to the server if the same command is returned again.

Supported remote command types:

  RESYNC_TODAY_PRESCRIPTIONS
  SYNC_REFERENCE_DATA
  SYNC_DRUG_MASTERS
  SYNC_STOCKS
  SYNC_BARCODES
  SYNC_WHOLESALERS
  SYNC_PURCHASES
  SYNC_CONTROLLED_DRUGS
  SYNC_DRUG_PRICES
  SYNC_DRUG_UNITS
  HEARTBEAT_NOW

Heartbeat:

- Default heartbeat: POST /agent/heartbeat every 60 seconds.
- Payload includes agentVersion, pharmacyId, deviceId, deviceName, hostNameHash, lastSqlOkAt, lastApiOkAt, pendingQueueCount, status, message, and capturedAt.
- If the heartbeat endpoint returns 404, heartbeat is disabled until the agent restarts.

Recommended operation:

1. Double-click install-pharmfarm-agent.bat.
2. Keep the default API unless the server changes.
3. Enter the 관리자 페이지 pharmacy ID. This must match pharmfarm_pharmacy.id on the server.
4. Keep SQL Server as .\EPHARM_DB unless the pharmacy PC differs.
5. Set a device alias that is easy to recognize in the web admin.
6. Leave "Include raw QR text" unchecked for production.
7. Finish setup.
8. Check the web prescription list after scanning/registering a QR in EPharm.

Updating an installed agent:

- Downloading/extracting a new zip does not update the running tray agent by itself.
- Extract the complete package OUTSIDE C:\ProgramData\PharmFarmAgent and run repair-pharmfarm-agent.bat.
- Repair preserves agent.config.json byte-for-byte, including pharmacy/device identity, custom options and credentials.
- Queue, sent files, prescription/reference hashes and logs are not cleared. Repair does not request TODAY_OVERWRITE or a manual resync.
- Setup/repair enters maintenance before stopping processes or replacing files, backs up runtime/task definitions, and verifies the registered tasks before resuming.
- If a task belongs to another Windows account, repair refuses to migrate it: use the original installation account. SQL uses that user's Windows integrated authentication.
- A same-name task targeting another installation or script is also refused before changes. A legacy manual launcher with no explicit installation path blocks overlap and requires its verified console to be closed; it is not blindly force-killed.
- Do not copy just PharmFarm-Agent.ps1: version 1.4.0-ps also needs the lifecycle helper and matching tray/watchdog files.
- The setup wizard is for a new installation or an intentional settings change; use repair for an update without configuration changes.
- The startup log should show the bundled agent version. If the version is old, the tray is still using the old ProgramData copy.
- resync-today-prescriptions.bat is an explicit, destructive overwrite test, not a repair tool. It refuses to overlap another agent and does not bypass a user pause or maintenance.

Automatic recovery (1.4.0-ps):

- PharmFarmAgent and PharmFarmAgentTray run at the original Windows user's login, with no runtime limit.
- PharmFarmAgentWatchdog also runs at login and repeats every minute indefinitely. Missed scheduled checks may run when Windows becomes available again.
- The watchdog can restore both processes even if neither tray nor collector is running. It is a short check with a two-minute execution limit so a hung check cannot permanently block later checks.
- Both registration routes (PowerShell and schtasks.exe) import the same XML: InteractiveToken, LeastPrivilege, IgnoreNew, battery operation allowed, missed-run recovery and failure retry.
- Registration is read back and checked. A Startup-only fallback is no longer reported as successful recovery protection.
- File-backed singleton locks protect collector, tray and watchdog, including manual/one-shot collector launches. Locks release when a process exits or crashes; do not delete .lock files while processes run.
- This is login-based recovery, not a Windows service: turning on a PC without signing in as the installed user does NOT start collection. Sleep, a disabled scheduler, antivirus blocking, or a broken installation can still prevent recovery.
- This watchdog repairs absent processes; it does not force-restart a live process for stale SQL/API state. A running icon is not proof of successful prescription collection.

User stop and maintenance:

- Tray > Agent Stop creates a durable pause BEFORE stopping collection. The pause survives tray restarts and PC reboots. Use Agent Start to resume deliberately.
- Closing the tray explicitly pauses only the tray, not the collector. Double-click run-agent-tray.bat to show it again. A crash does not set this pause and is automatically recovered.
- run-agent-console.bat is an explicit agent resume/troubleshooting action. It still refuses duplicates, maintenance and an uninstalled/disabled runtime.
- Installation, repair, removal and tray resync hold a maintenance lease so watchdog recovery cannot race file/state changes.
- An interrupted or failed maintenance operation leaves recovery blocked. Do not manually delete lifecycle files; rerun repair from the complete package and inspect its backup/error report.
- If an update fails after backup, old runtime files are restored where safe, but restored tasks stay DISABLED and legacy Startup shortcuts stay removed until repair succeeds. Their original XML/shortcuts remain in the backup. If process shutdown or rollback cannot be confirmed, the error explicitly reports that uncertainty.
- Uninstall marks the runtime disabled before stopping the watchdog. Runtime files and data are retained; use an intentional reinstall to re-enable an uninstalled agent.
- A recovery notice means collection during the stopped interval needs checking in CMS. Never use full overwrite resync just to dismiss the notice without reviewing its effect.

If data does not arrive:

1. Run run-agent-console.bat.
2. Check C:\ProgramData\PharmFarmAgent\logs.
3. Check C:\ProgramData\PharmFarmAgent\queue.
4. If queue files remain, the SQL side worked but API transmission failed.
5. If queue is empty and no logs appear, the agent may not be running.
6. If the tray says user-stopped, choose Agent Start. If it says maintenance, ask the administrator to inspect/repair the interrupted update.
7. If both icons/processes are absent after login, inspect PharmFarmAgentWatchdog in Task Scheduler and logs\watchdog-YYYYMMDD.log. Do not assume another product's tray icon is PharmFarm.
8. Confirm current agent.state.json / watchdog.state.json timestamps and the latest CMS heartbeat. Process recovery alone does not confirm SQL/API connectivity or backfill missing prescriptions.


Tray icon:

- Shows the PharmFarm mascot in the Windows notification area. Runtime state remains available in the icon tooltip and context menu.
- The tray and prescription collector are separate processes. The tray checks the actual scheduled task/process every 10 seconds instead of treating the tray icon itself as proof that collection is running.
- After a 20-second login/startup grace period, the tray automatically starts a stopped collector. It retries every 60 seconds while the collector remains stopped.
- A stopped collector changes the tray icon/tooltip to an error state. If automatic recovery fails, the user is told to right-click "에이전트 시작", check the log folder, and contact the administrator.
- When automatic recovery succeeds, the tray keeps a recovery warning until "오늘 처방 다시 확인" completes. The normal agent loop also performs its full scan of today's prescriptions after restart.
- Choosing "에이전트 중지" requires confirmation and pauses automatic recovery for the current tray session so an intentional stop is not immediately undone.
- Right-click to refresh status, open logs, open queue, start/stop the agent, or close the tray icon.
- Right-click "오늘 처방 다시 확인" to resend today's prescription rows with overwriteExisting=true when the collector was stopped or the admin page is missing prescriptions.
- Right-click "향정 후보 다시 동기화" to rescan only controlled-drug candidate sources.
- Right-click "참조 데이터 전체 다시 동기화" to rescan drug master, stock, barcode, wholesalers, prices, units, and controlled-drug candidates.
- Closing the tray icon does not remove the background scheduled task.

Today prescription overwrite test:

- Use this only before changing shortage/order/manual resolution statuses for the test prescriptions.
- The agent queries today's eP_ERROR_LOG.dbo.PRESCRIPT_EDB rows and their eP_PHARM.dbo.prsdrug lines.
- The today-row query avoids TRY_CONVERT so it can run on older EPharm SQL Server versions.
- The payload uses syncMode=TODAY_OVERWRITE and overwriteExisting=true.
- The server must upsert by prescriptionCode + lineNo and replace the stored prescription lines before running stock deduction again.
- The local live prescription snapshot state is also updated after this resend.
- Run from the tray menu, or run resync-today-prescriptions.bat from the extracted package.
- The tray menu uses the installed ProgramData copy. The extracted resync-today-prescriptions.bat uses the extracted package copy first.

Bootstrap sync:

- Initial data sync options are all unchecked by default.
- The installer can enable all initial syncs at once, or expand the detail panel and choose each heavy sync separately.
- Detail options: drug master, stock, barcode, wholesaler, controlled-drug candidates, drug prices, unit/barcode price data, and purchase history.
- Drug master sync reads eP_BASES.dbo.dgmast only when the drug master detail option is selected.
- Barcode sync reads eP_BASES.dbo.dgbarcode only when the barcode detail option is selected.
- Controlled-drug candidate sync uses controlled-drug-reference.csv extracted from 약품기본정보.pdf and eP_BASES.dbo.B21_PRODUCT_INFO rows whose B21_NRCD_SE_NM is 마약 or 향정.
- The PDF reference rows are sent directly to /agent/controlled-drugs with habitGroup=PDF and habitKind=PDF_REFERENCE, so pharmfarm_agent_controlled_drug contains the PDF baseline even when local ePharm reference tables do not match.
- The PDF reference is also matched against eP_BASES.dbo.habitdrug hd_iscode/HD_STORE and eP_BASES.dbo.dgmast dm_iscode/dm_drugcode for local DB evidence.
- DM_DAREGNO, DM_GODANG, DM_WARRINGMEMO, and dm_extype are kept as evidence fields, not as the primary inclusion rule.
- Purchase sync reads eP_PHARM.dbo.tradedrug only when the purchase history detail option is selected.
- Bootstrap data is queued first, then sent through the same retry mechanism.
- After the first run, the agent compares each row with C:\ProgramData\PharmFarmAgent\sync-state and queues only changed rows.
- Reference data is rescanned on agent start and then every 24 hours while the agent stays running.
- To force a resend without reinstalling, use the tray icon resync menu.

Server tables added for reference sync:

  pharmfarm_agent_controlled_drug
  pharmfarm_agent_drug_price
  pharmfarm_agent_drug_unit

Server progress check:

  select payload_type, count(*), sum(row_count)
  from pharmfarm_agent_ingest_event
  where pharmacy_id = 3
  group by payload_type;

Debug CSV export:

- debug-export-last-month-csv.bat exports local CSV files only.
- It scans visible EPharm databases and exports rows from the last 31 days.
- Tables without a usable date column are listed in manifest.csv as NO_DATE_COLUMN.
- Output folder: C:\ProgramData\PharmFarmAgent\debug-export\last-month-YYYYMMDD-HHMMSS
- This may include prescription or patient-related data. Do not upload/share without legal approval.

Debug table samples:

- debug-export-table-samples.bat exports local CSV files only.
- It scans visible EPharm databases and exports TOP 20 sample rows per table.
- It also writes manifest.csv with row counts and columns.csv with column metadata.
- Sensitive-looking columns are masked by column name pattern in sample CSV files.
- Output folder: C:\ProgramData\PharmFarmAgent\debug-export\table-samples-YYYYMMDD-HHMMSS
- This may still include prescription or pharmacy business data. Do not upload/share without legal approval.

Codex sharing helper:

- debug-export-table-samples.bat also creates SEND_TO_CODEX.txt.
- Send SEND_TO_CODEX.txt first. It summarizes table names, row counts, candidate columns, and sample file paths.
- Send manifest.csv/columns.csv only if more detail is needed.
- Avoid sending sample CSV files unless specifically requested.

Controlled-drug trace:

- controlled-drug-reference.csv is extracted from 약품기본정보.pdf printed on 2026-06-26.
- It contains 961 visible program drug codes from the PDF.
- debug-trace-controlled-drug.bat exports local CSV files by comparing the PDF reference list with the EPharm DB.
- dgmast matching checks PDF drugCode and componentCode against dm_iscode and dm_drugcode.
- Default: debug-trace-controlled-drug.bat
- Narrow trace examples: debug-trace-controlled-drug.bat -InsuranceCode 123456789
- Narrow trace examples: debug-trace-controlled-drug.bat -DrugName "drug name"
- Output folder: C:\ProgramData\PharmFarmAgent\debug-export\controlled-trace-YYYYMMDD-HHMMSS
- Files include pdf_reference.csv, reference_match_summary.csv, habitdrug_match.csv, dgmast_match.csv, dgtrans_price_match.csv, and summary.txt.
- Use this when a controlled-drug candidate looks wrong and the source DB columns need to be verified.
