// Same-user, windowless supervisor. No SQL, HTTP, shell or scheduled-task calls in its loop.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Threading;
using System.Security.Principal;

internal static class PharmFarmSupervisor
{
    internal const int PollSeconds = 10, StaleSeconds = 900;
    static string suspectProgress;
    static readonly Stopwatch suspectAge = new Stopwatch();
    internal static string Control(string root, string name) { return Path.Combine(root, "lifecycle", name); }

    internal static FileStream TryLock(string root, string name)
    {
        Directory.CreateDirectory(Path.Combine(root, "lifecycle"));
        try { return new FileStream(Control(root, name + ".lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { return null; }
    }

    internal static bool Locked(string root, string role)
    {
        using (FileStream file = TryLock(root, role)) { return file == null; }
    }

    internal static bool Allowed(string root, string role)
    {
        return !File.Exists(Control(root, "disabled.json")) &&
            !File.Exists(Control(root, "maintenance.json")) &&
            !File.Exists(Control(root, role + ".paused.json"));
    }

    internal static void AtomicWrite(string path, string text)
    {
        string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temp, text);
            if (File.Exists(path)) File.Replace(temp, path, null);
            else File.Move(temp, path);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    // Persisted budget survives supervisor restarts. Clock rollback fails closed.
    internal static bool ReserveAttempt(string root, string role, DateTime now)
    {
        string path = Control(root, "supervisor-" + role + ".retry");
        List<long> attempts = new List<long>();
        if (File.Exists(path))
        {
            foreach (string line in File.ReadAllLines(path))
            {
                long ticks;
                if (!long.TryParse(line, out ticks) || ticks <= 0 || ticks > now.Ticks) return false;
                if (now.Ticks - ticks < TimeSpan.FromMinutes(15).Ticks) attempts.Add(ticks);
            }
        }
        if (attempts.Count >= 3 || (attempts.Count > 0 && now.Ticks - attempts[attempts.Count - 1] < TimeSpan.FromSeconds(60).Ticks)) return false;
        attempts.Add(now.Ticks);
        AtomicWrite(path, string.Join(Environment.NewLine, attempts));
        return true;
    }

    internal static bool StaleProgress(string text, DateTime now, out int pid, out long started)
    {
        pid = 0; started = 0;
        string[] lines = text.Replace("\r", "").Trim().Split('\n');
        long updated;
        return lines.Length == 5 && lines[0] == "1" && int.TryParse(lines[1], out pid) && pid > 0 &&
            long.TryParse(lines[2], out started) && started > 0 &&
            long.TryParse(lines[3], out updated) && updated >= started && updated <= now.Ticks &&
            now.Ticks - updated >= TimeSpan.FromSeconds(StaleSeconds).Ticks;
    }

    internal static void Launch(string root, string role)
    {
        ProcessStartInfo info = new ProcessStartInfo(Path.Combine(root, "PharmFarm-AgentHost.exe"), "-Role " + role);
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        using (Process process = Process.Start(info))
            PharmFarmAgentHost.Log(root, "supervisor launch role=" + role + " hostPid=" + process.Id);
    }

    internal static int Watchdog(string root)
    {
        using (FileStream gate = TryLock(root, "gate"))
        {
            if (gate == null || !Allowed(root, "supervisor") || Locked(root, "supervisor")) return 0;
            if (!ReserveAttempt(root, "supervisor", DateTime.UtcNow))
            {
                PharmFarmAgentHost.Log(root, "watchdog supervisor restart deferred by retry budget");
                return 0;
            }
            try { PharmFarmAgentHost.LaunchDetachedSupervisor(root); }
            catch (System.ComponentModel.Win32Exception error)
            {
                if (error.NativeErrorCode != 5) throw;
                // Scheduler disallows direct Job breakaway on some Windows versions.
                // Local WMI is a separate process-creation broker; do not change any
                // service/security setting. Validate the suspended child before running it.
                LaunchViaLocalWmi(root);
            }
            return 0;
        }
    }

    static void LaunchViaLocalWmi(string root)
    {
        ManagementScope scope = new ManagementScope(@"\\.\root\cimv2");
        scope.Options.Impersonation = ImpersonationLevel.Impersonate;
        scope.Options.Timeout = TimeSpan.FromSeconds(10);
        scope.Connect();
        using (ManagementClass startupClass = new ManagementClass(scope, new ManagementPath("Win32_ProcessStartup"), null))
        using (ManagementObject startup = startupClass.CreateInstance())
        using (ManagementClass processClass = new ManagementClass(scope, new ManagementPath("Win32_Process"), null))
        using (ManagementBaseObject input = processClass.GetMethodParameters("Create"))
        {
            startup["ShowWindow"] = (ushort)0;
            startup["WinstationDesktop"] = @"WinSta0\Default";
            startup["CreateFlags"] = (uint)(0x01000000 | 0x08000000 | 0x00000004); // breakaway, no window, suspended
            string executable = Path.Combine(root, "PharmFarm-AgentHost.exe");
            input["CommandLine"] = PharmFarmAgentHost.Quote(executable) + " -Role supervisor";
            input["CurrentDirectory"] = root;
            input["ProcessStartupInformation"] = startup;
            using (ManagementBaseObject output = processClass.InvokeMethod("Create", input, new InvokeMethodOptions { Timeout = TimeSpan.FromSeconds(10) }))
            {
                uint result = Convert.ToUInt32(output["ReturnValue"]);
                if (result != 0) throw new InvalidOperationException("Local supervisor creation failed code=" + result);
                int pid = Convert.ToInt32(output["ProcessId"]);
                using (Process child = Process.GetProcessById(pid))
                {
                    bool resumed = false;
                    try
                    {
                        IntPtr handle = child.Handle;
                        using (ManagementObject row = new ManagementObject("Win32_Process.Handle='" + pid + "'"))
                        using (ManagementBaseObject owner = row.InvokeMethod("GetOwnerSid", null, null))
                        using (WindowsIdentity current = WindowsIdentity.GetCurrent())
                        {
                            if (Convert.ToUInt32(owner["ReturnValue"]) != 0 || Convert.ToString(owner["Sid"]) != current.User.Value ||
                                child.SessionId != Process.GetCurrentProcess().SessionId ||
                                PharmFarmAgentHost.IsElevated(child.Handle) != PharmFarmAgentHost.IsElevated(Process.GetCurrentProcess().Handle))
                                throw new InvalidOperationException("Supervisor identity/session/elevation mismatch; child was not resumed.");
                        }
                        PharmFarmAgentHost.ResumeCreatedProcess(child);
                        resumed = true;
                        PharmFarmAgentHost.Log(root, "local broker supervisor started pid=" + pid + " same-user/session/elevation verified");
                    }
                    finally { if (!resumed && !child.HasExited) { child.Kill(); child.WaitForExit(5000); } }
                }
            }
        }
    }

    static bool MatchesCollector(Process process, string root, long started)
    {
        // Bind the handle before inspecting identity so PID reuse cannot kill a replacement.
        IntPtr handle = process.Handle;
        if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != started) return false;
        using (ManagementObject row = new ManagementObject("Win32_Process.Handle='" + process.Id + "'"))
        {
            row.Options.Timeout = TimeSpan.FromSeconds(5);
            row.Get();
            string executable = Convert.ToString(row["ExecutablePath"]);
            string command = Convert.ToString(row["CommandLine"]);
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string expectedExe = Path.Combine(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            string expectedArgs = PharmFarmAgentHost.BuildArguments(new string[] { "-Role", "agent" }, root);
            // Only the installed host's exact regular collector command; never a resync or foreign script.
            return string.Equals(executable, expectedExe, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(command, PharmFarmAgentHost.Quote(expectedExe) + " " + expectedArgs, StringComparison.OrdinalIgnoreCase);
        }
    }

    static string CheckRole(string root, string role, DateTime now)
    {
        using (FileStream gate = TryLock(root, "gate"))
        {
            if (gate == null) return "busy";
            if (!Allowed(root, role)) return "suppressed";
            if (!Locked(root, role))
            {
                if (!ReserveAttempt(root, role, now)) return "retry-limited";
                Launch(root, role);
                return "start-requested";
            }
            if (role != "agent") return "running";
            string progressPath = Control(root, "agent.progress");
            if (!File.Exists(progressPath)) return "running-progress-unavailable";
            int pid; long started;
            string progress = File.ReadAllText(progressPath);
            if (!StaleProgress(progress, now, out pid, out started))
            {
                suspectProgress = null;
                suspectAge.Reset();
                return "running";
            }
            // Observe the SAME stalled sample for another minute. Resume from sleep,
            // clock adjustments and a supervisor restart must not kill a healthy worker.
            if (suspectProgress != progress)
            {
                suspectProgress = progress;
                suspectAge.Restart();
                return "stale-confirming";
            }
            if (suspectAge.Elapsed.TotalSeconds < 60) return "stale-confirming";
            using (Process collector = Process.GetProcessById(pid))
            {
                if (!MatchesCollector(collector, root, started)) return "stale-identity-unverified";
                // Progress may have advanced during WMI lookup. Never use an old sample to stop work.
                if (!Allowed(root, role) || File.ReadAllText(progressPath) != progress) return "running";
                if (!ReserveAttempt(root, role, now)) return "stale-retry-limited";
                PharmFarmAgentHost.Log(root, "supervisor stale collector pid=" + pid + " noProgressSeconds=" + StaleSeconds);
                collector.Kill();
                if (!collector.WaitForExit(5000)) return "stop-unconfirmed";
            }
            if (Locked(root, role)) return "stop-unconfirmed";
            Launch(root, role);
            return "stale-restart-requested";
        }
    }

    internal static int Run(string root)
    {
        using (FileStream singleton = TryLock(root, "supervisor"))
        {
            if (singleton == null) return 0;
            PharmFarmAgentHost.Log(root, "supervisor started pid=" + Process.GetCurrentProcess().Id);
            Dictionary<string, string> previous = new Dictionary<string, string>();
            Stopwatch interval = Stopwatch.StartNew();
            while (!File.Exists(Control(root, "disabled.json")))
            {
                if (interval.Elapsed.TotalSeconds > 45)
                {
                    // Sleep/resume or a delayed check breaks the confirmation sequence.
                    suspectProgress = null;
                    suspectAge.Reset();
                }
                interval.Restart();
                foreach (string role in new string[] { "agent", "tray" })
                {
                    string state;
                    try { state = CheckRole(root, role, DateTime.UtcNow); }
                    catch (Exception error) { state = "inspection-failed:" + error.GetType().Name; }
                    if (!previous.ContainsKey(role) || previous[role] != state)
                    {
                        PharmFarmAgentHost.Log(root, "supervisor role=" + role + " state=" + state);
                        previous[role] = state;
                    }
                }
                // No clinical/configuration data. Heartbeat is independent of SQL/network state.
                try { AtomicWrite(Control(root, "supervisor.progress"), DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)); }
                catch (Exception error) { PharmFarmAgentHost.Log(root, "supervisor state write failed: " + error.GetType().Name); }
                Thread.Sleep(PollSeconds * 1000);
            }
            PharmFarmAgentHost.Log(root, "supervisor disabled; exiting");
            return 0;
        }
    }
}
