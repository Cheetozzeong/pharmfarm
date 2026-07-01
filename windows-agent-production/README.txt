PharmFarm Production Agent

Target:
- Windows only
- No Git, Node, or npm required on the pharmacy PC
- Uses Windows PowerShell and Scheduled Task

Files:

1. install-pharmfarm-agent.bat
   Opens the setup wizard.
   The wizard copies PharmFarm-Agent.ps1 to ProgramData and creates a Scheduled Task.

2. PharmFarm-Agent.ps1
   Production-oriented local agent.
   Reads EPharm SQL Server with SELECT only.
   Queues data locally before sending it to the API.

3. PharmFarm-AgentTray.ps1
   Shows a PharmFarm status icon in the Windows tray area.
   The installer registers it as PharmFarmAgentTray.

4. run-agent-console.bat
   Runs the agent in a visible console for troubleshooting.

5. resync-today-prescriptions.bat
   Runs a one-time test sync for today's prescription rows.
   It sends overwriteExisting=true so the server can replace already imported prescription lines.

6. uninstall-pharmfarm-agent.bat
   Removes the Scheduled Task.
   Runtime queue/log files remain in ProgramData for recovery/audit.

Runtime path:

  C:\ProgramData\PharmFarmAgent

Runtime folders:

  queue       Pending events waiting to be sent
  sent        Successfully sent events
  dead-letter Payload errors that should not be retried
  logs        Daily log files
  sync-state  Local row hashes used to send only changed reference rows

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
- The server should preserve both lines for prescription detail display, but only pd_extype=0 or pd_extype=2 rows should affect stock deduction.
- If an older local DB does not expose pd_extype/pd_exrow/pd_element, the agent sends the prescription line as a normal row.

Recommended operation:

1. Double-click install-pharmfarm-agent.bat.
2. Keep the default API unless the server changes.
3. Enter the 관리자 페이지 pharmacy ID. This must match pharmfarm_pharmacy.id on the server.
4. Keep SQL Server as .\EPHARM_DB unless the pharmacy PC differs.
5. Set a device alias that is easy to recognize in the web admin.
6. Leave "Include raw QR text" unchecked for production.
7. Finish setup.
8. Check the web prescription list after scanning/registering a QR in EPharm.

If data does not arrive:

1. Run run-agent-console.bat.
2. Check C:\ProgramData\PharmFarmAgent\logs.
3. Check C:\ProgramData\PharmFarmAgent\queue.
4. If queue files remain, the SQL side worked but API transmission failed.
5. If queue is empty and no logs appear, the agent may not be running.


Tray icon:

- Shows PharmFarm running status in the Windows notification area.
- Right-click to refresh status, open logs, open queue, start/stop the agent, or close the tray icon.
- Right-click "금일 처방 다시 가져오기" to resend today's prescription rows with overwriteExisting=true.
- Right-click "향정 후보 다시 동기화" to rescan only controlled-drug candidate sources.
- Right-click "참조 데이터 전체 다시 동기화" to rescan drug master, stock, barcode, wholesalers, prices, units, and controlled-drug candidates.
- Closing the tray icon does not remove the background scheduled task.

Today prescription overwrite test:

- Use this only before changing shortage/order/manual resolution statuses for the test prescriptions.
- The agent queries today's eP_ERROR_LOG.dbo.PRESCRIPT_EDB rows and their eP_PHARM.dbo.prsdrug lines.
- The today-row query avoids TRY_CONVERT so it can run on older EPharm SQL Server versions.
- The payload uses syncMode=TODAY_OVERWRITE and overwriteExisting=true.
- The server must upsert by prescriptionCode + lineNo and replace the stored prescription lines before running stock deduction again.
- Run from the tray menu, or run resync-today-prescriptions.bat from the extracted package.

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
