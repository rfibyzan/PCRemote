// The dashboard as PC Remote's own window (no browser): a WinForms window
// with a WebView2 control showing http://127.0.0.1:<port>/.
//
// WebView2 is Microsoft's web engine for desktop apps (the "Evergreen
// Runtime", installed on Windows 10/11 even when the Edge browser was
// removed). The SDK files ship in runtime\agent\webview2\ (see VERSION.txt;
// inside the agent folder so the release zip and the one-click update zip
// both carry it):
//   Microsoft.Web.WebView2.Core.dll / .WinForms.dll  (loaded via
//   AssemblyResolve, see Install) and x64|arm64\WebView2Loader.dll.
// One window only: opening again brings it to the front. Links that leave
// the dashboard open in the user's normal browser. Show() returns false
// when WebView2 cannot start, so the launcher can fall back to a browser.
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PCRemote
{
    internal static class DashboardWindow
    {
        private static string libDir;
        private static Form form;
        private static WebView2 view;
        private static bool loaderSet;

        /// <summary>Make runtime\agent\webview2\*.dll loadable. Call once at start.</summary>
        public static void Install(string agentDir)
        {
            libDir = Path.Combine(agentDir, "webview2");
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
            {
                string name = new AssemblyName(e.Name).Name;
                if (!name.StartsWith("Microsoft.Web.WebView2", StringComparison.OrdinalIgnoreCase)) return null;
                string p = Path.Combine(libDir, name + ".dll");
                return File.Exists(p) ? Assembly.LoadFrom(p) : null;
            };
        }

        /// <summary>WebView2 runtime + SDK present? (cheap, no window).</summary>
        public static bool Available()
        {
            try
            {
                if (libDir == null || !File.Exists(Path.Combine(libDir, "Microsoft.Web.WebView2.Core.dll"))) return false;
                return Probe();
            }
            catch
            {
                return false;
            }
        }

        // Separate method: if the SDK dll is missing, only this JIT fails.
        private static bool Probe()
        {
            SetLoader();
            string v = CoreWebView2Environment.GetAvailableBrowserVersionString();
            return !string.IsNullOrEmpty(v);
        }

        private static void SetLoader()
        {
            if (loaderSet) return;
            string pa = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "";
            string arch = pa.Equals("ARM64", StringComparison.OrdinalIgnoreCase) ? "arm64" : "x64";
            CoreWebView2Environment.SetLoaderDllFolderPath(Path.Combine(libDir, arch));
            loaderSet = true;
        }

        /// <summary>Open (or focus) the window on url. False = use a browser instead.</summary>
        public static bool Show(string url, Icon icon, Action fallback)
        {
            try
            {
                if (form != null && !form.IsDisposed)
                {
                    if (view != null && view.CoreWebView2 != null && view.Source != null && view.Source.Port != new Uri(url).Port)
                        view.Source = new Uri(url);
                    if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
                    form.Show();
                    form.Activate();
                    return true;
                }
                if (!Available()) return false;
                Create(url, icon, fallback);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void Create(string url, Icon icon, Action fallback)
        {
            DashForm f = new DashForm(icon);
            form = f;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = ScaledSize(1100, 820);
            form.MinimumSize = new Size(480, 400);

            view = new WebView2();
            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = DashForm.Bg; // no white flash while loading
            f.Content.Controls.Add(view);
            form.FormClosed += delegate
            {
                try { if (view != null) view.Dispose(); } catch { }
                view = null;
                form = null;
            };
            form.Show();
            form.Activate();
            Init(url, fallback);
        }

        private static async void Init(string url, Action fallback)
        {
            WebView2 v = view;
            try
            {
                // Profile (cache, local storage) next to our other files, not
                // next to the exe (Program Files may not be writable).
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Path.Combine("PCRemote", "WebView2"));
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, data, null);
                await v.EnsureCoreWebView2Async(env);
                CoreWebView2 core = v.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsZoomControlEnabled = true;
                core.DocumentTitleChanged += delegate
                {
                    Form f = form;
                    if (f != null && !string.IsNullOrEmpty(core.DocumentTitle)) f.Text = core.DocumentTitle; // DashForm shows it in its title bar
                };
                // target=_blank / window.open: to the normal browser.
                core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
                {
                    e.Handled = true;
                    OpenExternal(e.Uri);
                };
                // Leaving the dashboard (e.g. GitHub link): normal browser too.
                core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
                {
                    Uri u;
                    if (Uri.TryCreate(e.Uri, UriKind.Absolute, out u) && !IsDashboard(u))
                    {
                        e.Cancel = true;
                        OpenExternal(e.Uri);
                    }
                };
                v.Source = new Uri(url);
            }
            catch
            {
                // Runtime refused to start: close our window, use a browser.
                try { if (form != null) form.Close(); } catch { }
                if (fallback != null) fallback();
            }
        }

        private static bool IsDashboard(Uri u)
        {
            if (u.Scheme == "about" || u.Scheme == "data") return true;
            return (u.Scheme == "http" || u.Scheme == "https") && (u.Host == "127.0.0.1" || u.Host == "localhost");
        }

        // Through explorer.exe: the browser runs as the signed-in user, not
        // elevated like the launcher.
        private static void OpenExternal(string uri)
        {
            try
            {
                string windir = Environment.GetEnvironmentVariable("WINDIR");
                string explorer = string.IsNullOrEmpty(windir) ? "explorer.exe" : Path.Combine(windir, "explorer.exe");
                System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo(explorer, "\"" + uri + "\"");
                psi.UseShellExecute = false;
                System.Diagnostics.Process.Start(psi);
            }
            catch { }
        }

        private static Size ScaledSize(int w, int h)
        {
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    float s = g.DpiX / 96f;
                    Rectangle work = Screen.PrimaryScreen.WorkingArea;
                    return new Size(Math.Min((int)(w * s), work.Width - 40), Math.Min((int)(h * s), work.Height - 40));
                }
            }
            catch
            {
                return new Size(w, h);
            }
        }
    }
}
