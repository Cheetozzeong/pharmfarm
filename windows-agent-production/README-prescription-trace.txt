PharmFarm prescription trace debug tools

Files:

- debug-export-prescription-trace.bat
- debug-export-prescription-trace.ps1

Default target:

- Prescription code: 202607010027
- Insurance codes: 629700750, 657300850

How to run:

1. Copy both files into the installed PharmFarm agent folder on the pharmacy PC.
2. Run debug-export-prescription-trace.bat.
3. To trace another prescription, run:

   debug-export-prescription-trace.bat 202607010027

Output:

- C:\ProgramData\PharmFarmAgent\debug-export\prescription-trace-CODE-YYYYMMDD-HHMMSS

Share order:

1. SEND_TO_CODEX.txt
2. manifest.csv and candidate_columns.csv if asked
3. Non-empty CSV files listed in SEND_TO_CODEX.txt if asked

Warning:

- Exported files may include prescription or patient-related data.
- Do not upload or share the folder unless legally approved.
