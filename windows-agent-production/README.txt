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
3. Keep SQL Server as .\EPHARM_DB unless the pharmacy PC differs.
4. Set a device alias that is easy to recognize in the web admin.
5. Leave "Include raw QR text" unchecked for production.
6. Finish setup.
7. Check the web prescription list after scanning/registering a QR in EPharm.

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
