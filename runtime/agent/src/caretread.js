/**
 * Caret readers for the phone's typing zoom (caret.js). Both return a
 * screen-pixel rect {x, y, w, h} or null:
 *  - readWin32Caret: GetGUIThreadInfo on the foreground thread (Notepad,
 *    dialogs, classic Win32 edits). Cheap, in-process.
 *  - createUiaReader: UI Automation through one long-lived PowerShell
 *    (caret-uia.ps1) for Chrome / Edge / Office / Electron, which do not
 *    expose a Win32 caret. Asked only when Win32 has nothing.
 */
import koffi from "koffi";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UIA_SCRIPT = path.resolve(here, "..", "caret-uia.ps1");
const UIA_TIMEOUT_MS = 300;
const UIA_RESPAWN_MS = 10000;

const user32 = koffi.load("user32.dll");
const CARET_RECT = koffi.struct("CARET_RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const CARET_POINT = koffi.struct("CARET_POINT", { x: "int32", y: "int32" });
const GUITHREADINFO = koffi.struct("CARET_GUITHREADINFO", {
  cbSize: "uint32",
  flags: "uint32",
  hwndActive: "void *",
  hwndFocus: "void *",
  hwndCapture: "void *",
  hwndMenuOwner: "void *",
  hwndMoveSize: "void *",
  hwndCaret: "void *",
  rcCaret: CARET_RECT,
});
const GetDpiForWindow = user32.func("uint32 __stdcall GetDpiForWindow(void *hwnd)");
const MonitorFromWindow = user32.func("void * __stdcall MonitorFromWindow(void *hwnd, uint32 dwFlags)");
let GetDpiForMonitor = null;
try {
  GetDpiForMonitor = koffi.load("shcore.dll").func("int32 __stdcall GetDpiForMonitor(void *hmonitor, int32 dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)");
} catch {
  GetDpiForMonitor = null;
}

// rcCaret is in the window's own (logical) client units. The agent is
// per-monitor DPI aware, so a DPI-unaware / system-aware app at 125-150 %
// needs its offsets scaled to physical pixels: monitor DPI / window DPI.
function dpiScale(hwnd) {
  try {
    const win = GetDpiForWindow(hwnd);
    if (!win || !GetDpiForMonitor) return 1;
    const mon = MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
    const x = [0];
    const y = [0];
    if (GetDpiForMonitor(mon, 0 /* MDT_EFFECTIVE_DPI */, x, y) !== 0 || !x[0]) return 1;
    return x[0] / win;
  } catch {
    return 1;
  }
}

const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, uint32 *lpdwProcessId)");
const GetGUIThreadInfo = user32.func("bool __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ CARET_GUITHREADINFO *pgui)");
const ClientToScreen = user32.func("bool __stdcall ClientToScreen(void *hWnd, _Inout_ CARET_POINT *lpPoint)");

export function readWin32Caret() {
  try {
    const fg = GetForegroundWindow();
    if (!fg) return null;
    const tid = GetWindowThreadProcessId(fg, null);
    if (!tid) return null;
    const gti = {
      cbSize: koffi.sizeof(GUITHREADINFO),
      flags: 0,
      hwndActive: null,
      hwndFocus: null,
      hwndCapture: null,
      hwndMenuOwner: null,
      hwndMoveSize: null,
      hwndCaret: null,
      rcCaret: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    if (!GetGUIThreadInfo(tid, gti) || !gti.hwndCaret) return null;
    const r = gti.rcCaret;
    const h = r.bottom - r.top;
    if (h <= 0) return null;
    const origin = { x: 0, y: 0 };
    if (!ClientToScreen(gti.hwndCaret, origin)) return null;
    const k = dpiScale(gti.hwndCaret);
    return { x: Math.round(origin.x + r.left * k), y: Math.round(origin.y + r.top * k), w: Math.max(1, Math.round((r.right - r.left) * k)), h: Math.round(h * k) };
  } catch {
    return null;
  }
}

/**
 * One PowerShell answering numbered questions ("q <n>") with a JSON line
 * {"n":<n>, x, y, w, h} ({"n":<n>} = no caret). read() resolves the rect,
 * null (no caret / process gone) or undefined (no answer in time: a slow
 * app; the late answer is dropped by its number). A dead process is
 * respawned at most every 10 s.
 */
export function createUiaReader({ spawn = nodeSpawn, now = Date.now } = {}) {
  let proc = null;
  let buf = "";
  let waiting = null; // { n, resolve, timer }
  let deadAt = 0;
  let seq = 0;

  function answer(v, n) {
    const w = waiting;
    if (!w || (n !== undefined && n !== w.n)) return;
    waiting = null;
    clearTimeout(w.timer);
    w.resolve(v);
  }

  function start() {
    if (proc) return proc;
    if (deadAt && now() - deadAt < UIA_RESPAWN_MS) return null;
    try {
      const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", UIA_SCRIPT], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const died = () => {
        if (proc !== p) return;
        proc = null;
        deadAt = now();
        answer(null);
      };
      p.on("error", died);
      p.stdin?.on?.("error", () => {}); // EPIPE after the process died
      p.on("exit", died);
      p.stdout.setEncoding?.("utf8");
      p.stdout.on("data", (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const n = parseN(line);
          if (n !== null) answer(parseRect(line), n);
        }
      });
      proc = p;
      return p;
    } catch {
      deadAt = now();
      return null;
    }
  }

  function read() {
    if (waiting) return Promise.resolve(undefined); // one question at a time
    const p = start();
    if (!p) return Promise.resolve(null);
    return new Promise((resolve) => {
      seq += 1;
      const n = seq;
      waiting = { n, resolve, timer: setTimeout(() => answer(undefined, n), UIA_TIMEOUT_MS) };
      try {
        p.stdin.write(`q ${n}\n`);
      } catch {
        answer(null);
      }
    });
  }

  function stop() {
    answer(null);
    const p = proc;
    proc = null;
    buf = "";
    deadAt = 0;
    try {
      p?.kill();
    } catch {
      // already gone
    }
  }

  return { read, stop };
}

function parseN(line) {
  try {
    const n = JSON.parse(line)?.n;
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function parseRect(line) {
  try {
    const v = JSON.parse(line);
    if (![v?.x, v?.y, v?.h].every(Number.isFinite) || v.h <= 0) return null;
    return { x: v.x, y: v.y, w: Number.isFinite(v.w) ? v.w : 1, h: v.h };
  } catch {
    return null;
  }
}
