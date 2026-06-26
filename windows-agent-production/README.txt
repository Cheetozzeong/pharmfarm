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

5. uninstall-pharmfarm-agent.bat
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

Recommended operation:

1. Double-click install-pharmfarm-agent.bat.
2. Keep the default API unless the server changes.
3. Enter the CMS pharmacy ID. This must match pharmfarm_pharmacy.id on the server.
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
- Closing the tray icon does not remove the background scheduled task.

Bootstrap sync:

- The installer can enable one-time drug master sync from eP_BASES.dbo.dgmast.
- The installer can enable one-time stock/barcode/wholesaler sync from eP_PHARM.dbo.STOCK, eP_BASES.dbo.dgbarcode, and eP_BASES.dbo.dealcorp.
- The same option also syncs controlled-drug candidates from eP_BASES.dbo.habitdrug, latest drug prices from eP_BASES.dbo.dgtrans, and unit/barcode price data from eP_BASES.dbo.dgunit.
- Purchase sync can be enabled by setting bootstrapPurchase=true in C:\ProgramData\PharmFarmAgent\agent.config.json.
- Bootstrap data is queued first, then sent through the same retry mechanism.
- After the first run, the agent compares each row with C:\ProgramData\PharmFarmAgent\sync-state and queues only changed rows.
- Reference data is rescanned on agent start and then every 24 hours while the agent stays running.
- To force a full resend for one data type, delete the matching *.hashes.json file in sync-state and restart the agent.

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
