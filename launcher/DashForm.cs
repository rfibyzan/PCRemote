// Dashboard window with a custom title bar (DashboardWindow.cs puts the
// WebView2 into Content).
//
// The window keeps the normal resizable style (WS_THICKFRAME), so Windows
// still gives it the shadow, Aero Snap (drag to an edge, Win+arrows, the
// Windows 11 snap layouts on maximize-hover are the only thing we lose),
// resize from the edges and a maximize that respects the taskbar. Only the
// native caption is removed (WM_NCCALCSIZE returns the whole window as
// client area) and drawn by us instead:
//   [logo] PC Remote ................................ [ - ] [ □ ] [ × ]
// in the dashboard's own colours (index.js: --bg #0e0e10, --line #36363a).
// Dragging the bar = dragging the caption (snap works), double click =
// maximize / restore. A thin margin around the content (hidden while
// maximized) is where the edges can be grabbed: the WebView2 child window
// would otherwise swallow those clicks.
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace PCRemote
{
    internal sealed class DashForm : Form
    {
        public static readonly Color Bg = Color.FromArgb(14, 14, 16);
        private static readonly Color Line = Color.FromArgb(54, 54, 58);
        private static readonly Color Fg = Color.FromArgb(242, 242, 245);
        private static readonly Color Muted = Color.FromArgb(142, 142, 147);
        private static readonly Color Hover = Color.FromArgb(44, 44, 48);
        private static readonly Color Press = Color.FromArgb(58, 58, 62);
        private static readonly Color CloseHover = Color.FromArgb(232, 17, 35);

        public readonly Panel Content;
        private readonly Panel bar;
        private readonly Label title;
        private readonly Button btnMax;
        private readonly float scale;

        public DashForm(Icon icon)
        {
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
            Text = "PC Remote";
            if (icon != null) Icon = icon;
            BackColor = Bg;
            FormBorderStyle = FormBorderStyle.Sizable;
            DoubleBuffered = true;
            Padding = new Padding(Px(5));

            Content = new Panel();
            Content.Dock = DockStyle.Fill;
            Content.BackColor = Bg;

            Panel line = new Panel();
            line.Dock = DockStyle.Top;
            line.Height = 1;
            line.BackColor = Line;

            bar = new Panel();
            bar.Dock = DockStyle.Top;
            bar.Height = Px(40);
            bar.BackColor = Bg;

            // Right: window buttons (Segoe MDL2 Assets glyphs, as Windows uses).
            Button btnClose = CaptionButton("", "Tutup");
            btnClose.FlatAppearance.MouseOverBackColor = CloseHover;
            btnClose.FlatAppearance.MouseDownBackColor = Color.FromArgb(241, 112, 122);
            btnClose.Click += delegate { Close(); };
            btnMax = CaptionButton("", "Maksimalkan");
            btnMax.Click += delegate { ToggleMaximize(); };
            Button btnMin = CaptionButton("", "Minimalkan");
            btnMin.Click += delegate { WindowState = FormWindowState.Minimized; };

            // Left: logo + title (both drag the window like a caption).
            PictureBox logo = new PictureBox();
            logo.Dock = DockStyle.Left;
            logo.Width = Px(44);
            logo.SizeMode = PictureBoxSizeMode.CenterImage;
            if (icon != null)
            {
                using (Icon small = new Icon(icon, Px(18), Px(18)))
                    logo.Image = new Bitmap(small.ToBitmap(), new Size(Px(18), Px(18)));
            }

            title = new Label();
            title.Dock = DockStyle.Fill;
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.ForeColor = Fg;
            title.Font = new Font("Segoe UI Semibold", 9.75f, FontStyle.Regular, GraphicsUnit.Point);
            title.Text = Text;
            title.AutoEllipsis = true;

            // Dock order: the last added control docks first.
            bar.Controls.Add(title);
            bar.Controls.Add(logo);
            bar.Controls.Add(btnMin);
            bar.Controls.Add(btnMax);
            bar.Controls.Add(btnClose);
            foreach (Control c in new Control[] { bar, logo, title })
            {
                c.MouseDown += OnBarMouseDown;
                c.MouseDoubleClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ToggleMaximize(); };
            }

            Controls.Add(Content);
            Controls.Add(line);
            Controls.Add(bar);
        }

        private int Px(int v)
        {
            return (int)Math.Round(v * scale);
        }

        private Button CaptionButton(string glyph, string name)
        {
            Button b = new Button();
            b.Dock = DockStyle.Right;
            b.Width = Px(46);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = Hover;
            b.FlatAppearance.MouseDownBackColor = Press;
            b.BackColor = Bg;
            b.ForeColor = Fg;
            b.Font = new Font("Segoe MDL2 Assets", 7.5f, FontStyle.Regular, GraphicsUnit.Point);
            b.Text = glyph;
            b.TabStop = false;
            b.AccessibleName = name;
            b.Cursor = Cursors.Default;
            return b;
        }

        private void ToggleMaximize()
        {
            WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
        }

        private void OnBarMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left || e.Clicks > 1) return;
            // Hand the drag to Windows as a caption drag: move + Aero Snap.
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }

        protected override void OnTextChanged(EventArgs e)
        {
            base.OnTextChanged(e);
            if (title != null) title.Text = Text;
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            if (title != null) title.ForeColor = Fg;
        }

        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            if (title != null) title.ForeColor = Muted;
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (btnMax == null) return;
            bool max = WindowState == FormWindowState.Maximized;
            btnMax.Text = max ? "" : "";
            btnMax.AccessibleName = max ? "Pulihkan" : "Maksimalkan";
            // The grab margin only makes sense while the edges can be dragged.
            Padding = max ? Padding.Empty : new Padding(Px(5));
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int on = 1;
                DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, 4);
                int round = 2; // DWMWCP_ROUND (Windows 11; ignored on 10)
                DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, 4);
                // Keeps the DWM shadow on a window without a caption.
                MARGINS m = new MARGINS();
                m.Top = 1;
                DwmExtendFrameIntoClientArea(Handle, ref m);
            }
            catch { }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                // Whole window = client area (no native caption). Maximized
                // windows hang the frame off-screen: pull the content back in.
                if (WindowState == FormWindowState.Maximized)
                {
                    RECT r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
                    int fx = GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
                    int fy = GetSystemMetrics(SM_CYSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
                    r.Left += fx;
                    r.Right -= fx;
                    r.Top += fy;
                    r.Bottom -= fy;
                    Marshal.StructureToPtr(r, m.LParam, false);
                }
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
            {
                base.WndProc(ref m);
                if ((int)m.Result != HTCLIENT) return;
                int x = (short)((long)m.LParam & 0xFFFF);
                int y = (short)(((long)m.LParam >> 16) & 0xFFFF);
                Point p = PointToClient(new Point(x, y));
                int b = Px(6);
                bool left = p.X < b, right = p.X >= ClientSize.Width - b;
                bool top = p.Y < b, bottom = p.Y >= ClientSize.Height - b;
                int hit = top && left ? HTTOPLEFT : top && right ? HTTOPRIGHT : bottom && left ? HTBOTTOMLEFT
                    : bottom && right ? HTBOTTOMRIGHT : left ? HTLEFT : right ? HTRIGHT : top ? HTTOP : bottom ? HTBOTTOM : HTCLIENT;
                m.Result = (IntPtr)hit;
                return;
            }
            base.WndProc(ref m);
        }

        // ---------------------------------------------------------- native

        private const int WM_NCCALCSIZE = 0x0083;
        private const int WM_NCHITTEST = 0x0084;
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int HTCLIENT = 1, HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
            HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        private const int SM_CXSIZEFRAME = 32, SM_CYSIZEFRAME = 33, SM_CXPADDEDBORDER = 92;
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_WINDOW_CORNER_PREFERENCE = 33;

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MARGINS { public int Left, Right, Top, Bottom; }

        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);
    }
}
