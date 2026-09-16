// Build as a deterministic AnyCPU .NET Framework 4.6.2 WindowsApplication.
// No console, shell, elevation, credentials, arbitrary executable or arbitrary script arguments.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class PharmFarmAgentHost
{
    const uint CREATE_SUSPENDED = 0x00000004, CREATE_NO_WINDOW = 0x08000000;
    const uint KILL_ON_JOB_CLOSE = 0x00002000, SILENT_BREAKAWAY_OK = 0x00001000;
    const uint INFINITE = 0xffffffff;

    [STAThread]
    public static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        try
        {
            if (args.Length == 2 && args[0] == "-Role" && args[1] == "supervisor")
                return PharmFarmSupervisor.Run(root);
            // Native backup: never start a periodic PowerShell just to inspect a lock.
            if (args.Length == 2 && args[0] == "-Role" && args[1] == "watchdog")
                return PharmFarmSupervisor.Watchdog(root);
            if (args.Length == 0) args = new string[] { "-Role", "tray", "-Resume" };
            string arguments = BuildArguments(args, root);
            if (args.Length == 3 && args[1] == "tray" && args[2] == "-Resume")
            {
                // Explicit manual tray launch also restores independent supervision,
                // even while the Schedule service is down. Never block the tray on failure.
                try { PharmFarmSupervisor.Watchdog(root); }
                catch (Exception error) { Log(root, "manual supervisor start failed: " + error.Message); }
            }
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            // AnyCPU runs as 64-bit on 64-bit Windows, preserving the installed SQL provider.
            string powershell = Path.Combine(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            string role = args.Length > 1 ? args[1] : "self-test";
            if (role != "watchdog") Log(root, "host started role=" + role + " pid=" + System.Diagnostics.Process.GetCurrentProcess().Id);
            int result = Run(powershell, arguments, root);
            if (role != "watchdog" || result != 0) Log(root, "host exited role=" + role + " exitCode=" + result);
            return result;
        }
        catch (Exception error)
        {
            Log(root, "launch failed: " + error.Message);
            return 1;
        }
    }

    internal static void Log(string root, string message)
    {
        try
        {
            string logs = Path.Combine(root, "logs");
            Directory.CreateDirectory(logs);
            string path = Path.Combine(logs, "launcher-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
            // Bound even repeated failures; keep the previous chunk for diagnosis.
            if (File.Exists(path) && new FileInfo(path).Length > 2 * 1024 * 1024)
            {
                string previous = path + ".previous";
                if (File.Exists(previous)) File.Delete(previous);
                File.Move(path, previous);
            }
            File.AppendAllText(path, DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine);
        }
        catch { /* Logging must never display a window or prevent recovery. */ }
    }

    internal static string Quote(string value)
    {
        // CommandLineToArgvW quoting, including trailing backslashes and embedded quotes.
        StringBuilder output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); slashes = 0; continue; }
            output.Append('\\', slashes); slashes = 0; output.Append(c);
        }
        output.Append('\\', slashes * 2); output.Append('"');
        return output.ToString();
    }

    internal static void LaunchDetachedSupervisor(string root)
    {
        string executable = Path.Combine(root, "PharmFarm-AgentHost.exe");
        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(startup);
        startup.dwFlags = 1;
        PROCESS_INFORMATION process;
        // Do not silently fall back to a child tied to Scheduler's Job. If breakaway
        // is prohibited, the caller uses a validated local broker instead.
        if (!CreateProcess(executable, new StringBuilder(Quote(executable) + " -Role supervisor"), IntPtr.Zero, IntPtr.Zero,
            false, CREATE_NO_WINDOW | 0x01000000, IntPtr.Zero, root, ref startup, out process)) throw new Win32Exception();
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        Log(root, "detached supervisor launch pid=" + process.dwProcessId);
    }

    internal static bool IsElevated(IntPtr process)
    {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception();
        try
        {
            int elevated; uint length;
            if (!GetTokenInformation(token, 20, out elevated, 4, out length)) throw new Win32Exception();
            return elevated != 0;
        }
        finally { CloseHandle(token); }
    }

    internal static void ResumeCreatedProcess(System.Diagnostics.Process process)
    {
        if (process.Threads.Count != 1) throw new InvalidOperationException("Unexpected suspended supervisor threads.");
        IntPtr thread = OpenThread(2, false, (uint)process.Threads[0].Id);
        if (thread == IntPtr.Zero) throw new Win32Exception();
        try { if (ResumeThread(thread) == uint.MaxValue) throw new Win32Exception(); }
        finally { CloseHandle(thread); }
    }

    internal static string BuildArguments(string[] args, string root)
    {
        if (args.Length == 1 && args[0] == "-SelfTest")
            return "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command \"exit 0\"";
        if (args.Length < 2 || args[0] != "-Role") throw new ArgumentException("Expected -Role agent, tray, or watchdog.");
        string role = args[1];
        string script;
        if (role == "agent") script = "PharmFarm-Agent.ps1";
        else if (role == "tray") script = "PharmFarm-AgentTray.ps1";
        else if (role == "watchdog") script = "PharmFarm-AgentWatchdog.ps1";
        else throw new ArgumentException("Unknown role.");
        string path = Path.Combine(root, script);
        if (!File.Exists(path)) throw new FileNotFoundException("Required runtime script is missing.", script);
        string command = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " + Quote(path);
        command += role == "agent" ? " -ConfigPath " + Quote(Path.Combine(root, "agent.config.json")) : " -InstallRoot " + Quote(root);
        if (args.Length == 3 && role == "tray" && args[2] == "-Resume") command += " -Resume";
        else if (args.Length == 5 && role == "agent" && args[2] == "-ResyncTodayPrescriptions" && args[3] == "-MaintenanceToken")
        {
            Guid token;
            if (args[4].Length != 32 || !Guid.TryParseExact(args[4], "N", out token)) throw new ArgumentException("Invalid maintenance token.");
            command += " -ResyncTodayPrescriptions -MaintenanceToken " + Quote(args[4]);
        }
        else if (args.Length != 2) throw new ArgumentException("Unsupported role arguments.");
        return command;
    }

    static int Run(string executable, string arguments, string directory)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool completed = false;
        try
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            // Tie the primary PS process to this host (including Scheduler timeout/end).
            // Recovery children must survive the short-lived watchdog, so they break away
            // from this job and their own host creates a separate job for their lifetime.
            limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(startup);
            startup.dwFlags = 1; // STARTF_USESHOWWINDOW
            startup.wShowWindow = 0; // SW_HIDE, secondary protection; CREATE_NO_WINDOW is primary.
            if (!CreateProcess(executable, new StringBuilder(Quote(executable) + " " + arguments), IntPtr.Zero, IntPtr.Zero,
                false, CREATE_NO_WINDOW | CREATE_SUSPENDED, IntPtr.Zero, directory, ref startup, out process)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception();
            if (ResumeThread(process.hThread) == uint.MaxValue) throw new Win32Exception();
            Log(directory, "child started pid=" + process.dwProcessId + " hostPid=" + System.Diagnostics.Process.GetCurrentProcess().Id);
            if (WaitForSingleObject(process.hProcess, INFINITE) != 0) throw new Win32Exception();
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception();
            completed = true;
            return unchecked((int)exitCode);
        }
        finally
        {
            // A failed assignment/resume must never leave an untracked suspended process.
            if (!completed && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            CloseHandle(job);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public uint cb; public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, uint threadId);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, out int information, uint length, out uint returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
}
