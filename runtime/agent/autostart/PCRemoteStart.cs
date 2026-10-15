// PCRemoteStart.exe: the program HKCU\...\Run "PC Remote" points at.
//
// Task Manager > Startup names an entry after the target exe's FileDescription
// (AssemblyTitle) and Publisher (AssemblyCompany). Pointing Run straight at
// schtasks.exe showed "Task Scheduler Configuration Tool / Microsoft". This
// helper carries our own name and icon, runs as the normal user (asInvoker,
// the csc default manifest), starts the elevated scheduled task "PCRemote"
// and exits. /target:winexe means no console window; schtasks itself is started
// hidden. Any error is swallowed: there is nobody to show it to at log-on.
//
// Kept to C# 5 so the csc.exe that ships with .NET Framework 4.x
// (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe) compiles it. Built
// by runtime/agent/src/autostart.js; see cscArgs() there for the command line.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("PC Remote")]
[assembly: AssemblyDescription("Starts PC Remote at sign-in (Task Scheduler task \"PCRemote\").")]
[assembly: AssemblyProduct("PC Remote")]
[assembly: AssemblyCompany("PCRemote")]
[assembly: AssemblyCopyright("github.com/rfibyzan/PCRemote")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0")]

namespace PCRemote
{
    internal static class Start
    {
        private const string DefaultTask = "PCRemote";

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                string task = (args != null && args.Length > 0 && args[0].Trim().Length > 0) ? args[0].Trim() : DefaultTask;
                string root = Environment.GetEnvironmentVariable("SystemRoot");
                if (string.IsNullOrEmpty(root)) root = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
                string schtasks = Path.Combine(Path.Combine(root, "System32"), "schtasks.exe");
                if (!File.Exists(schtasks)) schtasks = "schtasks.exe";

                ProcessStartInfo psi = new ProcessStartInfo(schtasks, "/run /tn \"" + task.Replace("\"", "") + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.ErrorDialog = false;
                using (Process p = Process.Start(psi))
                {
                    if (p == null) return 1;
                    // Give schtasks a moment so its exit code is ours; never hang log-on.
                    if (!p.WaitForExit(15000)) return 2;
                    return p.ExitCode;
                }
            }
            catch
            {
                return 1;
            }
        }
    }
}
