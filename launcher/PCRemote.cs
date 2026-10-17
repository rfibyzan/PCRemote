// PCRemote.cs: PCRemote.exe, the launcher next to the runtime folder.
//
//   PCRemote\
//     PCRemote.exe          <- this program (requireAdministrator, app.manifest)
//     runtime\node.exe
//     runtime\agent\src\index.js, runtime\agent\icon.ico, ...
//
// What it does (same contract as the old closed-source PCRemote.exe):
//   1. One launcher per session (mutex Local\PCRemote.Launcher). Starting it
//      again replaces the running PC Remote.
//   2. Replacing: ask every PC Remote agent on 127.0.0.1:18765-18774 to quit
//      (POST /api/quit, see runtime/agent/src/quit.js). Agents too old for
//      that, or hung, are killed, but ONLY a node.exe that is LISTENING on an
//      agent port (Netstat.cs) and is either this install's runtime\node.exe
//      or answers /health as PC Remote. Its children are killed only when they
//      are PC Remote's own (node/cloudflared/ffmpeg or inside this folder).
//      The old launcher killed every PID netstat listed near those ports with
//      taskkill /T, which included the browser showing the dashboard.
//   3. Unblock-File on the folder (downloaded zip), then run
//      runtime\node.exe src\index.js in runtime\agent with PATH=runtime;...,
//      PCREMOTE_TRAY=1, PCREMOTE_LAUNCHER=1 (the agent then shows no tray of
//      its own) and PCREMOTE_HOME=<this folder>.
//   4. Own the tray icon: left click / "Open dashboard" opens
//      http://127.0.0.1:<port>/, "Close PC Remote" stops the agent and exits.
//   5. Agent exit code 0 = done (closed, or another PC Remote already runs);
//      75 = restart asked (dashboard "Mulai ulang", POST /api/restart): start
//      it again after 2 s; anything else = crash, restart after 5 s (30 s if
//      it keeps crashing), like runtime\agent\start.bat.
//   6. Tray "Restart agent": stop the agent the same way as Close, then start
//      it again after 2 s while the launcher (and its tray) keeps running, so
//      a remote user never has to reopen PC Remote by hand.
//
// Kept to C# 5 so the csc.exe that ships with .NET Framework 4.x compiles it.
// Build: launcher\build.bat (or the CI / release workflows).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("PC Remote")]
[assembly: AssemblyDescription("Starts the PC Remote agent and its tray icon.")]
[assembly: AssemblyProduct("PC Remote")]
[assembly: AssemblyCompany("PCRemote")]
[assembly: AssemblyCopyright("github.com/rfibyzan/PCRemote")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]
[assembly: AssemblyInformationalVersion("1.2.0")]

namespace PCRemote
{
    internal static class Program
    {
        private const string Title = "PC Remote";
        private const string MutexName = "Local\\PCRemote.Launcher";
        private const string ReplaceFailed = "Could not replace the old PC Remote. Close it in Task Manager and try again.";

        private static string root;
        private static string runtimeDir;
        private static string agentDir;
        private static string nodeExe;
        private static int selfPid;

        private static readonly object agentLock = new object();
        private static Process agent;
        private static volatile bool stopping;
        private static volatile bool exitUi;
        private static volatile bool restartRequested;
        private static NotifyIcon trayIcon;
        private const int RestartCode = 75;
        private const int RestartDelayMs = 2000;
        private static volatile int agentPort;

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            selfPid = Process.GetCurrentProcess().Id;

            root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            runtimeDir = Path.Combine(root, "runtime");
            nodeExe = Path.Combine(runtimeDir, "node.exe");
            agentDir = Path.Combine(runtimeDir, "agent");
            string indexJs = Path.Combine(Path.Combine(agentDir, "src"), "index.js");
            if (!File.Exists(nodeExe) || !File.Exists(indexJs))
            {
                MessageBox.Show("Keep PCRemote.exe in the same folder as the runtime folder.", Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 2;
            }

            Mutex mutex = new Mutex(false, MutexName);
            bool owned = TryTake(mutex, 0);
            if (!owned)
            {
                StopOtherLaunchers();
                owned = TryTake(mutex, 10000);
            }
            if (!owned)
            {
                MessageBox.Show(ReplaceFailed, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                mutex.Dispose();
                return 1;
            }

            try
            {
                if (!ReplaceOldAgents())
                {
                    MessageBox.Show(ReplaceFailed, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                UnblockTree(root);
                return RunTray();
            }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { }
                mutex.Dispose();
            }
        }

        private static bool TryTake(Mutex mutex, int ms)
        {
            try { return mutex.WaitOne(ms); }
            catch (AbandonedMutexException) { return true; }
        }

        // ---------------------------------------------------------------- tray

        private static int RunTray()
        {
            Icon icon = SystemIcons.Application;
            try
            {
                string ico = Path.Combine(agentDir, "icon.ico");
                if (File.Exists(ico)) icon = new Icon(ico);
            }
            catch { }

            NotifyIcon tray = new NotifyIcon();
            tray.Text = Title;
            tray.Icon = icon;
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open dashboard", null, delegate { OpenDashboard(); });
            menu.Items.Add("Restart agent", null, delegate { RequestRestart(); });
            menu.Items.Add("Close PC Remote", null, delegate { RequestStop(); });
            tray.ContextMenuStrip = menu;
            tray.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) OpenDashboard();
            };
            tray.Visible = true;
            trayIcon = tray;

            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 400;
            timer.Tick += delegate
            {
                if (exitUi)
                {
                    timer.Stop();
                    Application.ExitThread();
                }
            };
            timer.Start();

            Thread loop = new Thread(RunAgentLoop);
            loop.IsBackground = true;
            loop.Start();

            tray.ShowBalloonTip(5000, Title, "Running. Click this icon for the pairing code.", ToolTipIcon.Info);
            Application.Run();

            timer.Stop();
            tray.Visible = false;
            tray.Dispose();
            stopping = true;
            StopAgent();
            return 0;
        }

        private static void RequestStop()
        {
            if (stopping) return;
            stopping = true;
            Thread t = new Thread(delegate()
            {
                StopAgent();
                exitUi = true;
            });
            t.IsBackground = true;
            t.Start();
        }

        /// "Restart agent": stop it like Close, but keep the launcher; the
        /// agent loop sees restartRequested and starts it again.
        private static void RequestRestart()
        {
            if (stopping || restartRequested) return;
            restartRequested = true;
            Thread t = new Thread(delegate()
            {
                Process p;
                lock (agentLock) p = agent;
                if (p == null || HasExited(p))
                {
                    restartRequested = false; // the loop is already about to start it
                    return;
                }
                StopAgent();
            });
            t.IsBackground = true;
            t.Start();
        }

        private static void Balloon(string text)
        {
            NotifyIcon tray = trayIcon;
            if (tray == null) return;
            try { tray.ShowBalloonTip(3000, Title, text, ToolTipIcon.Info); } catch { }
        }

        private static void OpenDashboard()
        {
            int port = agentPort;
            if (port == 0) port = DiscoverPort();
            if (port == 0) port = Netstat.FirstPort;
            string url = "http://127.0.0.1:" + port + "/";
            // Through explorer.exe so the browser runs as the signed-in user
            // (not elevated like us) and is not our child process.
            try
            {
                string windir = Environment.GetEnvironmentVariable("WINDIR");
                string explorer = string.IsNullOrEmpty(windir) ? "explorer.exe" : Path.Combine(windir, "explorer.exe");
                ProcessStartInfo psi = new ProcessStartInfo(explorer, "\"" + url + "\"");
                psi.UseShellExecute = false;
                Process.Start(psi);
            }
            catch
            {
                try { Process.Start(url); } catch { }
            }
        }

        // --------------------------------------------------------------- agent

        private static void RunAgentLoop()
        {
            int quickCrashes = 0;
            while (!stopping)
            {
                Process p;
                DateTime started = DateTime.UtcNow;
                try
                {
                    p = StartAgent();
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Could not start PC Remote: " + ex.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    break;
                }
                lock (agentLock) agent = p;

                Thread finder = new Thread(delegate()
                {
                    for (int i = 0; i < 120 && !stopping && !HasExited(p) && agentPort == 0; i++)
                    {
                        int port = DiscoverPort();
                        if (port != 0) { agentPort = port; break; }
                        Thread.Sleep(500);
                    }
                });
                finder.IsBackground = true;
                finder.Start();

                p.WaitForExit();
                int code = 1;
                try { code = p.ExitCode; } catch { }
                lock (agentLock) agent = null;
                agentPort = 0;
                if (stopping) break;
                if (restartRequested || code == RestartCode)
                {
                    restartRequested = false;
                    quickCrashes = 0;
                    Balloon("Restarting the agent...");
                    for (int waited = 0; waited < RestartDelayMs && !stopping; waited += 250) Thread.Sleep(250);
                    continue;
                }
                if (code == 0) break;

                double ran = (DateTime.UtcNow - started).TotalSeconds;
                quickCrashes = ran < 30 ? quickCrashes + 1 : 0;
                int waitMs = quickCrashes > 3 ? 30000 : 5000;
                for (int waited = 0; waited < waitMs && !stopping; waited += 250) Thread.Sleep(250);
            }
            exitUi = true;
        }

        private static Process StartAgent()
        {
            ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "src\\index.js");
            psi.WorkingDirectory = agentDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            psi.EnvironmentVariables["PATH"] = runtimeDir + Path.PathSeparator + path;
            psi.EnvironmentVariables["PCREMOTE_TRAY"] = "1";
            psi.EnvironmentVariables["PCREMOTE_LAUNCHER"] = "1";
            psi.EnvironmentVariables["PCREMOTE_HOME"] = root;
            return Process.Start(psi);
        }

        /// "Close PC Remote": ask our agent to quit, then make sure it and its
        /// own helpers (cloudflared, ffmpeg) are gone.
        private static void StopAgent()
        {
            Process p;
            lock (agentLock) p = agent;
            if (p == null || HasExited(p)) return;
            List<Proc> tree = SafeTree(p.Id, true);
            int port = agentPort;
            if (port == 0) port = DiscoverPort();
            if (port != 0) RequestQuit(port);
            try { p.WaitForExit(5000); } catch { }
            KillAll(tree);
        }

        private static bool HasExited(Process p)
        {
            try { return p.HasExited; } catch { return true; }
        }

        // ------------------------------------------------- replacing old copies

        /// Older launchers (any folder) hold the tray and restart the agent.
        /// Only the launcher process itself is ended, never its tree: a browser
        /// it opened would be in that tree. Its agent is handled below.
        private static void StopOtherLaunchers()
        {
            foreach (Process p in Process.GetProcessesByName("PCRemote"))
            {
                try
                {
                    if (p.Id == selfPid) continue;
                    p.Kill();
                    p.WaitForExit(3000);
                }
                catch { }
                finally { p.Dispose(); }
            }
        }

        /// True when no PC Remote agent answers on the agent ports afterwards.
        private static bool ReplaceOldAgents()
        {
            List<int> answering = PortsAnswering();
            List<Proc> targets = ListeningAgentTrees(answering);
            if (answering.Count == 0 && targets.Count == 0) return true;

            foreach (int port in answering) RequestQuit(port);
            if (answering.Count > 0) WaitUntil(delegate { return PortsAnswering().Count == 0 && AllExited(targets); }, 6000);

            // Too old for /api/quit, or hung: kill, but only the safe set.
            KillAll(targets);
            KillAll(ListeningAgentTrees(PortsAnswering()));
            return WaitUntil(delegate { return PortsAnswering().Count == 0; }, 5000);
        }

        /// node.exe processes LISTENING on an agent port that are PC Remote:
        /// this install's runtime\node.exe, or the port answers /health as PC
        /// Remote. Each comes with its safe child processes.
        private static List<Proc> ListeningAgentTrees(List<int> pcremotePorts)
        {
            List<Proc> result = new List<Proc>();
            HashSet<int> seen = new HashSet<int>();
            foreach (string line in RunNetstat())
            {
                int pid, port;
                if (!Netstat.TryParseListeningPid(line, out pid, out port)) continue;
                if (pid == selfPid || seen.Contains(pid)) continue;
                string image = ImagePath(pid);
                if (!string.Equals(Path.GetFileName(image), "node.exe", StringComparison.OrdinalIgnoreCase)) continue;
                if (!IsInside(image, runtimeDir) && !pcremotePorts.Contains(port)) continue;
                seen.Add(pid);
                result.AddRange(SafeTree(pid, true));
            }
            return result;
        }

        private static string[] RunNetstat()
        {
            try
            {
                string windir = Environment.GetEnvironmentVariable("WINDIR");
                string exe = "netstat.exe";
                if (!string.IsNullOrEmpty(windir))
                {
                    string full = Path.Combine(Path.Combine(windir, "System32"), "netstat.exe");
                    if (File.Exists(full)) exe = full;
                }
                ProcessStartInfo psi = new ProcessStartInfo(exe, "-ano");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                using (Process p = Process.Start(psi))
                {
                    string text = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(10000);
                    return text.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                }
            }
            catch
            {
                return new string[0];
            }
        }

        // ----------------------------------------------------------- processes

        private sealed class Proc
        {
            public int Pid;
            public DateTime Started;
        }

        /// pid (when includeRoot) plus its descendants that belong to PC Remote:
        /// node.exe, cloudflared.exe, ffmpeg.exe, or anything run from this
        /// folder. Other children (a browser, powershell, ...) are left alone
        /// and not walked into. Children first, so KillAll ends them before
        /// the parent.
        private static List<Proc> SafeTree(int pid, bool includeRoot)
        {
            Dictionary<int, List<int>> children = ChildMap();
            List<Proc> result = new List<Proc>();
            HashSet<int> visited = new HashSet<int>();
            Walk(pid, children, visited, result);
            if (includeRoot)
            {
                Proc r = Snapshot(pid);
                if (r != null) result.Add(r);
            }
            return result;
        }

        private static void Walk(int parent, Dictionary<int, List<int>> children, HashSet<int> visited, List<Proc> result)
        {
            if (!visited.Add(parent)) return;
            List<int> kids;
            if (!children.TryGetValue(parent, out kids)) return;
            DateTime parentStart = StartTime(parent);
            foreach (int kid in kids)
            {
                if (kid == selfPid || kid == parent) continue;
                // A reused PID that only looks like a child started before its "parent".
                DateTime kidStart = StartTime(kid);
                if (parentStart != DateTime.MinValue && kidStart != DateTime.MinValue && kidStart < parentStart) continue;
                if (!IsOurHelper(ImagePath(kid))) continue;
                Walk(kid, children, visited, result);
                Proc pr = Snapshot(kid);
                if (pr != null) result.Add(pr);
            }
        }

        private static bool IsOurHelper(string image)
        {
            if (string.IsNullOrEmpty(image)) return false;
            if (IsInside(image, root)) return true;
            string name = Path.GetFileName(image);
            return string.Equals(name, "node.exe", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "cloudflared.exe", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "ffmpeg.exe", StringComparison.OrdinalIgnoreCase);
        }

        private static Proc Snapshot(int pid)
        {
            DateTime s = StartTime(pid);
            if (s == DateTime.MinValue) return null;
            Proc p = new Proc();
            p.Pid = pid;
            p.Started = s;
            return p;
        }

        /// Process.Kill on each, no /T. Skips a PID that now belongs to a
        /// different process (start time changed).
        private static void KillAll(List<Proc> list)
        {
            foreach (Proc pr in list)
            {
                if (pr.Pid == selfPid) continue;
                try
                {
                    using (Process p = Process.GetProcessById(pr.Pid))
                    {
                        if (p.HasExited || p.StartTime != pr.Started) continue;
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                }
                catch { }
            }
        }

        private static bool AllExited(List<Proc> list)
        {
            foreach (Proc pr in list)
            {
                if (StartTime(pr.Pid) == pr.Started) return false;
            }
            return true;
        }

        private static DateTime StartTime(int pid)
        {
            try
            {
                using (Process p = Process.GetProcessById(pid))
                {
                    if (p.HasExited) return DateTime.MinValue;
                    return p.StartTime;
                }
            }
            catch
            {
                return DateTime.MinValue;
            }
        }

        private static bool IsInside(string file, string dir)
        {
            if (string.IsNullOrEmpty(file) || string.IsNullOrEmpty(dir)) return false;
            try
            {
                string f = Path.GetFullPath(file);
                string d = Path.GetFullPath(dir).TrimEnd('\\', '/') + "\\";
                return f.StartsWith(d, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        // ------------------------------------------------------------ Win32

        private const uint TH32CS_SNAPPROCESS = 0x00000002;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

        [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static Dictionary<int, List<int>> ChildMap()
        {
            Dictionary<int, List<int>> map = new Dictionary<int, List<int>>();
            IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
            try
            {
                PROCESSENTRY32 e = new PROCESSENTRY32();
                e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32First(snap, ref e)) return map;
                do
                {
                    int pid = (int)e.th32ProcessID;
                    int parent = (int)e.th32ParentProcessID;
                    List<int> kids;
                    if (!map.TryGetValue(parent, out kids))
                    {
                        kids = new List<int>();
                        map[parent] = kids;
                    }
                    kids.Add(pid);
                } while (Process32Next(snap, ref e));
            }
            finally
            {
                CloseHandle(snap);
            }
            return map;
        }

        private static string ImagePath(int pid)
        {
            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString(0, size) : "";
            }
            finally
            {
                CloseHandle(h);
            }
        }

        // ------------------------------------------------------------- HTTP

        private static List<int> PortsAnswering()
        {
            List<int> ports = new List<int>();
            for (int port = Netstat.FirstPort; port < Netstat.FirstPort + Netstat.PortCount; port++)
            {
                if (HealthOk(port)) ports.Add(port);
            }
            return ports;
        }

        private static int DiscoverPort()
        {
            for (int port = Netstat.FirstPort; port < Netstat.FirstPort + Netstat.PortCount; port++)
            {
                if (HealthOk(port)) return port;
            }
            return 0;
        }

        /// GET /health looks like a PC Remote agent ({"ok":true,...,"monitors":[...]}).
        private static bool HealthOk(int port)
        {
            string body = Http("GET", port, "/health", 800);
            return body != null && body.Contains("\"ok\":true") && body.Contains("\"monitors\"");
        }

        /// POST /api/quit (runtime/agent/src/quit.js). False on agents that
        /// predate it; the caller falls back to the safe kill.
        private static bool RequestQuit(int port)
        {
            string body = Http("POST", port, "/api/quit", 2000);
            return body != null && body.Contains("\"quit\":true");
        }

        private static string Http(string method, int port, string path, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
                req.Method = method;
                req.Proxy = null;
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.KeepAlive = false;
                if (method == "POST")
                {
                    req.Headers["X-PCRemote"] = "1";
                    req.ContentLength = 0;
                }
                using (WebResponse res = req.GetResponse())
                using (StreamReader reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd().Replace(" ", "");
                }
            }
            catch
            {
                return null;
            }
        }

        private delegate bool Check();

        private static bool WaitUntil(Check done, int ms)
        {
            DateTime end = DateTime.UtcNow.AddMilliseconds(ms);
            while (true)
            {
                if (done()) return true;
                if (DateTime.UtcNow >= end) return false;
                Thread.Sleep(300);
            }
        }

        // ---------------------------------------------------------- unblock

        /// A folder unzipped from a download is marked as from the internet;
        /// clear that so node/ffmpeg/cloudflared and the .ps1 files run.
        private static void UnblockTree(string dir)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"Get-ChildItem -LiteralPath '"
                    + dir.Replace("'", "''")
                    + "' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(30000);
                }
            }
            catch { }
        }
    }
}
