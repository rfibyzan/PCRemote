/**
 * Explorer "Send to > PC Remote (HP)": right-click files on the PC and they
 * go to the connected phone (filexfer.js).
 *
 * The agent writes %LOCALAPPDATA%\PCRemote\sendto.ps1 (with its current
 * port) on every start, and once creates the shortcut
 * %APPDATA%\Microsoft\Windows\SendTo\PC Remote (HP).lnk that runs it.
 * Explorer appends the selected paths as arguments; the script POSTs them to
 * http://127.0.0.1:<port>/api/send-files with the x-pcremote header (the
 * agent's local-only, CSRF-guarded admin API).
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SENDTO_NAME = "PC Remote (HP).lnk";

export function sendtoScript(port) {
  const p = Number(port) | 0;
  return `# PC Remote: Explorer "Send to" helper (written by the agent, port ${p}).
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)
$ErrorActionPreference = 'Stop'
function Say($text) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($text, 'PC Remote') | Out-Null
}
if (-not $Paths -or $Paths.Count -eq 0) { exit 0 }
$body = [System.Text.Encoding]::UTF8.GetBytes((@{ paths = @($Paths) } | ConvertTo-Json -Compress))
try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:${p}/api/send-files' -Method Post -Headers @{ 'x-pcremote' = '1' } -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 10
  if (-not $r.ok) { Say ('Tidak terkirim: ' + $r.error) }
} catch {
  Say 'PC Remote belum berjalan atau HP tidak tersambung.'
}
`;
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}

/** Write the helper for this port and make sure the shortcut exists. */
export function installSendTo(port, log = () => {}) {
  if (process.platform !== "win32" || !process.env.APPDATA) return;
  try {
    const dir = path.join(localAppData(), "PCRemote");
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "sendto.ps1");
    fs.writeFileSync(script, sendtoScript(port), "utf8");
    const lnk = path.join(process.env.APPDATA, "Microsoft", "Windows", "SendTo", SENDTO_NAME);
    if (fs.existsSync(lnk)) return;
    const icon = fileURLToPath(new URL("../icon.ico", import.meta.url));
    const q = (s) => String(s).replace(/'/g, "''");
    const ps = [
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + q(lnk) + "')",
      "$s.TargetPath = \"$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
      "$s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + q(script) + "\"'",
      "$s.WindowStyle = 7",
      fs.existsSync(icon) ? "$s.IconLocation = '" + q(icon) + "'" : "",
      "$s.Description = 'Kirim ke HP lewat PC Remote'",
      "$s.Save()",
    ]
      .filter(Boolean)
      .join("; ");
    execFile("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 15000 }, (err) => {
      if (err) log(`Send to: shortcut gagal dibuat (${err.message})`);
      else log("Send to: menu 'PC Remote (HP)' dipasang di Explorer");
    });
  } catch (err) {
    log(`Send to: ${err?.message || err}`);
  }
}
