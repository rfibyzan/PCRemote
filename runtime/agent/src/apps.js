/**
 * App launcher: lists every app in the Start menu (shell:AppsFolder, desktop
 * and Store apps alike) with its real icon, and starts one on request.
 * One PowerShell run builds the list (icons via IShellItemImageFactory, 48 px
 * PNG); it is cached for CACHE_MS and only ids from that list can be started.
 */
import { execFile } from "node:child_process";
import { appsForPhone, cleanApps } from "./appsmath.js";

const CACHE_MS = 10 * 60 * 1000;
let cache = null; // { at, list }
let running = null;

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.IO; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class PcrAppIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  public static string Get(string parsing, int px) {
    try {
      IShellItemImageFactory f;
      SHCreateItemFromParsingName(parsing, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
      SIZE s; s.cx = px; s.cy = px; IntPtr hb;
      if (f.GetImage(s, 0x4, out hb) != 0 || hb == IntPtr.Zero) return null;
      try {
        using (Bitmap b = Image.FromHbitmap(hb)) {
          Rectangle r = new Rectangle(0, 0, b.Width, b.Height);
          BitmapData d = b.LockBits(r, ImageLockMode.ReadOnly, b.PixelFormat);
          try {
            using (Bitmap a = new Bitmap(b.Width, b.Height, d.Stride, PixelFormat.Format32bppArgb, d.Scan0))
            using (MemoryStream ms = new MemoryStream()) { a.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
          } finally { b.UnlockBits(d); }
        }
      } finally { DeleteObject(hb); }
    } catch { return null; }
  }
}
"@
$sh = New-Object -ComObject Shell.Application
$rows = foreach ($i in $sh.NameSpace('shell:AppsFolder').Items()) {
  $id = $i.Path; $n = $i.Name
  if (-not $id -or -not $n) { continue }
  $t = $i.ExtendedProperty('System.Link.TargetParsingPath')
  [pscustomobject]@{ id = $id; name = $n; target = $t; icon = [PcrAppIcon]::Get("shell:AppsFolder\$id", 48) }
}
@($rows) | ConvertTo-Json -Compress -Depth 3
`;

function runPs(script, timeout = 90000) {
  const enc = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
      { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout || ""))),
    );
  });
}

async function scan() {
  const out = await runPs(SCRIPT);
  const start = out.search(/[[{]/);
  const rows = start >= 0 ? JSON.parse(out.slice(start)) : [];
  return cleanApps(rows);
}

export async function listApps(refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return appsForPhone(cache.list);
  if (!running) {
    running = scan()
      .then((list) => {
        cache = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        running = null;
      });
  }
  return appsForPhone(await running);
}

// Only apps from the last scan can be started. admin=true asks Windows for
// elevation (UAC shows on the PC's secure desktop; confirm it there).
export function openApp(id, admin = false) {
  const app = cache?.list.find((a) => a.id === id);
  if (!app) return false;
  if (admin && app.admin && app.target) {
    const p = app.target.replace(/'/g, "''");
    runPs(`Start-Process -FilePath '${p}' -Verb RunAs`, 30000).catch(() => {});
    return true;
  }
  execFile("explorer.exe", [`shell:AppsFolder\\${app.id}`], { windowsHide: true }, () => {});
  return true;
}
