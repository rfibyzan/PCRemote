/**
 * Top-level window list + focus/minimize/close for the single-window stream.
 * Win32 via koffi; pure placement/filter logic lives in windowmath.js.
 * Window ids are HWND values as numbers (stable while the window exists).
 */
import koffi from "koffi";
import { listMonitors } from "./monitors.js";
import { exeName, listable, placeWindow } from "./windowmath.js";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const dwmapi = koffi.load("dwmapi.dll");

const WRECT = koffi.struct("WinRECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const EnumWindowsProc = koffi.proto("bool __stdcall PcrEnumWindowsProc(intptr hwnd, intptr lParam)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(PcrEnumWindowsProc *cb, intptr lParam)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(intptr hwnd)");
const IsWindow = user32.func("bool __stdcall IsWindow(intptr hwnd)");
const IsIconicW = user32.func("bool __stdcall IsIconic(intptr hwnd)");
const GetWindowTextW = user32.func("int32 __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16_t *buf, int32 max)");
const GetWindowLongPtrW = user32.func("intptr __stdcall GetWindowLongPtrW(intptr hwnd, int32 index)");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(intptr hwnd, _Out_ WinRECT *r)");
const GetWindowThreadProcessIdW = user32.func("uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)");
const ShowWindowW = user32.func("bool __stdcall ShowWindow(intptr hwnd, int32 cmd)");
const SetForegroundWindowW = user32.func("bool __stdcall SetForegroundWindow(intptr hwnd)");
const BringWindowToTopW = user32.func("bool __stdcall BringWindowToTop(intptr hwnd)");
const GetForegroundWindowW = user32.func("intptr __stdcall GetForegroundWindow()");
const AttachThreadInputW = user32.func("bool __stdcall AttachThreadInput(uint32 a, uint32 b, int32 attach)");
const PostMessageW = user32.func("bool __stdcall PostMessageW(intptr hwnd, uint32 msg, uintptr w, intptr l)");
const GetCurrentThreadIdW = kernel32.func("uint32 __stdcall GetCurrentThreadId()");
const OpenProcess = kernel32.func("intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(intptr h)");
const QueryFullProcessImageNameW = kernel32.func(
  "bool __stdcall QueryFullProcessImageNameW(intptr h, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)",
);
const DwmGetWindowAttributeRect = dwmapi.func(
  "int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ WinRECT *value, uint32 size)",
);
const DwmGetWindowAttributeInt = dwmapi.func(
  "int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ int32 *value, uint32 size)",
);

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WM_CLOSE = 0x10;

function wide(buf, n) {
  return String.fromCharCode(...buf.slice(0, Math.max(0, n))).replace(/\0.*$/, "");
}

function titleOf(h) {
  const buf = new Uint16Array(256);
  const n = GetWindowTextW(h, buf, 256);
  return wide(Array.from(buf), n);
}

const exeCache = new Map();
function processName(h) {
  const pidOut = [0];
  GetWindowThreadProcessIdW(h, pidOut);
  const pid = pidOut[0];
  if (!pid) return "";
  if (exeCache.has(pid)) return exeCache.get(pid);
  let name = "";
  const ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (ph) {
    const buf = new Uint16Array(520);
    const size = [520];
    if (QueryFullProcessImageNameW(ph, 0, buf, size)) name = exeName(wide(Array.from(buf), size[0]));
    CloseHandle(ph);
  }
  if (exeCache.size > 300) exeCache.clear();
  exeCache.set(pid, name);
  return name;
}

function frameRect(h) {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  // Extended frame bounds exclude the invisible resize border Win10/11 adds.
  if (DwmGetWindowAttributeRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(WRECT)) !== 0) GetWindowRect(h, r);
  return r;
}

/** [{id, title, exe, min, mon, x, y, w, h}] in Z-order (top first). Never throws. */
export function listWindows() {
  const out = [];
  try {
    const monitors = listMonitors();
    const own = process.pid;
    const cb = koffi.register((h) => {
      try {
        if (!IsWindowVisible(h)) return true;
        const title = titleOf(h);
        const ex = Number(GetWindowLongPtrW(h, GWL_EXSTYLE));
        const cloaked = [0];
        DwmGetWindowAttributeInt(h, DWMWA_CLOAKED, cloaked, 4);
        const min = IsIconicW(h);
        const r = frameRect(h);
        const ok = listable({
          visible: true,
          title,
          toolWindow: Boolean(ex & WS_EX_TOOLWINDOW),
          cloaked: Boolean(cloaked[0]),
          w: min ? 999 : r.right - r.left,
          h: min ? 999 : r.bottom - r.top,
        });
        if (!ok) return true;
        const pidOut = [0];
        GetWindowThreadProcessIdW(h, pidOut);
        if (pidOut[0] === own) return true;
        const place = min ? null : placeWindow(r, monitors);
        if (!min && !place) return true;
        out.push({ id: Number(h), title: title.slice(0, 120), exe: processName(h), min: Boolean(min), ...(place || { mon: null }) });
      } catch {
        // skip this window
      }
      return true;
    }, koffi.pointer(EnumWindowsProc));
    EnumWindows(cb, 0);
    koffi.unregister(cb);
  } catch (err) {
    console.warn("listWindows failed:", err.message);
  }
  return out.slice(0, 60);
}

function forceForeground(h) {
  const fg = Number(GetForegroundWindowW());
  const cur = GetCurrentThreadIdW();
  const fgTid = fg ? GetWindowThreadProcessIdW(fg, [0]) : 0;
  const tid = GetWindowThreadProcessIdW(h, [0]);
  if (fgTid && fgTid !== cur) AttachThreadInputW(cur, fgTid, 1);
  if (tid && tid !== cur) AttachThreadInputW(cur, tid, 1);
  if (IsIconicW(h)) ShowWindowW(h, 9); // SW_RESTORE
  BringWindowToTopW(h);
  SetForegroundWindowW(h);
  if (fgTid && fgTid !== cur) AttachThreadInputW(cur, fgTid, 0);
  if (tid && tid !== cur) AttachThreadInputW(cur, tid, 0);
}

/** focus | min | max | close one window by id. Returns false when it is gone. */
export function windowAction(id, action) {
  const h = Number(id) || 0;
  if (!h || !IsWindow(h)) return false;
  if (action === "focus") forceForeground(h);
  else if (action === "min") ShowWindowW(h, 6); // SW_MINIMIZE
  else if (action === "max") {
    ShowWindowW(h, 3); // SW_MAXIMIZE
    forceForeground(h);
  } else if (action === "close") PostMessageW(h, WM_CLOSE, 0, 0);
  return true;
}
