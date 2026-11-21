// App identity for Windows notifications.
//
// Windows names a desktop app's notifications (and picks the small icon in
// their header) from its AppUserModelID. Without one it guesses from the exe
// path and caches that icon, which is why PC Remote's notifications kept the
// old white icon. The launcher therefore:
//   1. claims an explicit AppUserModelID for its process, and
//   2. keeps a Start Menu shortcut "PC Remote" carrying the same id, our
//      icon and PCRemote.exe as target. Windows reads the name + icon for
//      the notifications from that shortcut (Microsoft's documented way for
//      desktop apps) and PC Remote also shows up in Start search.
// Everything here is best effort: a failure never stops the launcher.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace PCRemote
{
    internal static class AppIdentity
    {
        public const string AppId = "rfibyzan.PCRemote";
        private const string LinkName = "PC Remote.lnk";

        [DllImport("shell32.dll", SetLastError = true)]
        private static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string appId);

        public static void Claim()
        {
            try { SetCurrentProcessExplicitAppUserModelID(AppId); } catch { }
        }

        public static void EnsureStartMenuShortcut(string exePath, string iconPath)
        {
            try
            {
                string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                if (string.IsNullOrEmpty(programs)) return;
                string lnk = Path.Combine(programs, LinkName);

                IShellLinkW link = (IShellLinkW)new CShellLink();
                link.SetPath(exePath);
                link.SetWorkingDirectory(Path.GetDirectoryName(exePath));
                link.SetDescription("Remote PC dari HP");
                if (File.Exists(iconPath)) link.SetIconLocation(iconPath, 0);

                IPropertyStore store = (IPropertyStore)link;
                PROPERTYKEY key = new PROPERTYKEY();
                key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // PKEY_AppUserModel_ID
                key.pid = 5;
                PROPVARIANT value = new PROPVARIANT();
                value.vt = 31; // VT_LPWSTR
                value.p = Marshal.StringToCoTaskMemUni(AppId);
                try
                {
                    store.SetValue(ref key, ref value);
                    store.Commit();
                }
                finally
                {
                    Marshal.FreeCoTaskMem(value.p);
                }

                ((IPersistFile)link).Save(lnk, true);
                Marshal.FinalReleaseComObject(link);
            }
            catch { }
        }

        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class CShellLink { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr findData, uint flags);
            void GetIDList(out IntPtr pidl);
            void SetIDList(IntPtr pidl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
            void GetHotkey(out short hotkey);
            void SetHotkey(short hotkey);
            void GetShowCmd(out int showCmd);
            void SetShowCmd(int showCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int cch, out int iconIndex);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relPath, uint reserved);
            void Resolve(IntPtr hwnd, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
        private interface IPropertyStore
        {
            void GetCount(out uint count);
            void GetAt(uint index, out PROPERTYKEY key);
            void GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
            void SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
            void Commit();
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct PROPERTYKEY
        {
            public Guid fmtid;
            public uint pid;
        }

        // PROPVARIANT holding a string pointer (VT_LPWSTR); 24 bytes on x64.
        [StructLayout(LayoutKind.Explicit, Size = 24)]
        private struct PROPVARIANT
        {
            [FieldOffset(0)] public ushort vt;
            [FieldOffset(8)] public IntPtr p;
        }
    }
}
