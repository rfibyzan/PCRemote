import koffi from "koffi";
import { execFile } from "node:child_process";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

try {
  const shcore = koffi.load("shcore.dll");
  const SetProcessDpiAwareness = shcore.func("int32 __stdcall SetProcessDpiAwareness(int32 value)");
  SetProcessDpiAwareness(2);
} catch {
  // Older Windows still works with default DPI.
}

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_XDOWN = 0x0080;
const MOUSEEVENTF_XUP = 0x0100;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_MOVE_NOCOALESCE = 0x2000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_SCANCODE = 0x0008;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const XBUTTON1 = 0x0001;
const XBUTTON2 = 0x0002;
const MAPVK_VK_TO_VSC = 0;
const GA_ROOT = 2;

const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16",
  wScan: "uint16",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uint64",
});

const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
  dx: "int32",
  dy: "int32",
  mouseData: "uint32",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uint64",
});

const INPUT = koffi.struct("INPUT", {
  type: "uint32",
  u: koffi.union({
    mi: MOUSEINPUT,
    ki: KEYBDINPUT,
  }),
});

const POINT = koffi.struct("POINT", {
  x: "int32",
  y: "int32",
});

const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, const INPUT *pInputs, int32 cbSize)");
 // keybd_event deliberately unused: pairing it with SendInput double-fires every key.
 // LockWorkStation is bound directly (no rundll32 child process to fail silently).
const LockWorkStationFn = user32.func("bool __stdcall LockWorkStation()");
const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int32 x, int32 y)");
const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)");
const GetSystemMetrics = user32.func("int32 __stdcall GetSystemMetrics(int32 nIndex)");
const MapVirtualKeyW = user32.func("uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)");
const GetAsyncKeyState = user32.func("int16 __stdcall GetAsyncKeyState(int32 vKey)");
const WindowFromPoint = user32.func("void * __stdcall WindowFromPoint(POINT pt)");
const GetAncestor = user32.func("void * __stdcall GetAncestor(void *hwnd, uint32 gaFlags)");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void *hWnd)");
const BringWindowToTop = user32.func("bool __stdcall BringWindowToTop(void *hWnd)");
const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hWnd, int32 nCmdShow)");
const IsIconic = user32.func("bool __stdcall IsIconic(void *hWnd)");
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const GetWindowThreadProcessId = user32.func(
  "uint32 __stdcall GetWindowThreadProcessId(void *hWnd, uint32 *lpdwProcessId)",
);
const AttachThreadInput = user32.func("bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int32 fAttach)");
const AllowSetForegroundWindow = user32.func("bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)");
const GetCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");

const INPUT_SIZE = koffi.sizeof(INPUT);

const VK = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  alt: 0x12,
  pause: 0x13,
  caps: 0x14,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  win: 0x5b,
  rwin: 0x5c,
  apps: 0x5d,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
  lshift: 0xa0,
  rshift: 0xa1,
  lctrl: 0xa2,
  rctrl: 0xa3,
  lalt: 0xa4,
  ralt: 0xa5,
  volmute: 0xad,
  voldown: 0xae,
  volup: 0xaf,
  next: 0xb0,
  prev: 0xb1,
  stop: 0xb3,
  play: 0xb4,
};

const NAMED_KEYS = new Map(
  Object.entries(VK).concat([
    ["return", VK.enter],
    ["escape", VK.esc],
    ["windows", VK.win],
    ["start", VK.win],
    ["cmd", VK.win],
    ["meta", VK.win],
    ["control", VK.ctrl],
    ["menu", VK.alt],
    ["del", VK.delete],
    ["ins", VK.insert],
    ["pgup", VK.pageup],
    ["pgdn", VK.pagedown],
    ["lwin", VK.win],
  ]),
);

for (let i = 0; i < 26; i += 1) {
  NAMED_KEYS.set(String.fromCharCode(97 + i), 0x41 + i);
}
for (let i = 0; i <= 9; i += 1) {
  NAMED_KEYS.set(String(i), 0x30 + i);
}
for (const [ch, vk] of [
  ["-", 0xbd],
  ["=", 0xbb],
  [",", 0xbc],
  [".", 0xbe],
  ["/", 0xbf],
  [";", 0xba],
  ["'", 0xde],
  ["[", 0xdb],
  ["]", 0xdd],
  ["\\", 0xdc],
  ["`", 0xc0],
]) {
  NAMED_KEYS.set(ch, vk);
}

const EXTENDED = new Set([
  VK.left,
  VK.right,
  VK.up,
  VK.down,
  VK.home,
  VK.end,
  VK.pageup,
  VK.pagedown,
  VK.insert,
  VK.delete,
  VK.win,
  VK.rwin,
  VK.apps,
  VK.rctrl,
  VK.ralt,
]);

const SHELL_KEYS = new Set(["win", "windows", "start", "lwin", "rwin", "alt", "tab"]);

let lastPos = null;
let buttonsDown = 0;
let lastFocusAt = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function inputStructSize() {
  return INPUT_SIZE;
}

function sendInputs(items) {
  if (!items.length) return 0;
  return SendInput(items.length, items, INPUT_SIZE);
}

function mousePacket(dx, dy, data, flags) {
  return {
    type: INPUT_MOUSE,
    u: {
      mi: {
        dx,
        dy,
        mouseData: data >>> 0,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0n,
      },
    },
  };
}

function keyPacket(vk, scan, flags) {
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: scan,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0n,
      },
    },
  };
}

export function screenSize() {
  return {
    w: GetSystemMetrics(0) || 1920,
    h: GetSystemMetrics(1) || 1080,
    vx: GetSystemMetrics(76) || 0,
    vy: GetSystemMetrics(77) || 0,
    vw: GetSystemMetrics(78) || GetSystemMetrics(0) || 1920,
    vh: GetSystemMetrics(79) || GetSystemMetrics(1) || 1080,
  };
}

export function cursorPos() {
  const point = { x: 0, y: 0 };
  GetCursorPos(point);
  return point;
}

export function toVirtualAbs(x, y) {
  const { vx, vy, vw, vh } = screenSize();
  return {
    dx: Math.round(((Number(x) - vx) * 65535) / Math.max(1, vw - 1)),
    dy: Math.round(((Number(y) - vy) * 65535) / Math.max(1, vh - 1)),
  };
}

export function monitorPoint(mon, nx, ny) {
  if (!mon) {
    const size = screenSize();
    return {
      x: Math.max(0, Math.min(size.w - 1, Math.round(Number(nx) * (size.w - 1)))),
      y: Math.max(0, Math.min(size.h - 1, Math.round(Number(ny) * (size.h - 1)))),
    };
  }
  return {
    x: Math.round(mon.left + Number(nx) * Math.max(1, mon.w - 1)),
    y: Math.round(mon.top + Number(ny) * Math.max(1, mon.h - 1)),
  };
}

function sendAbsolute(x, y) {
  const tx = Math.round(x);
  const ty = Math.round(y);
  const abs = toVirtualAbs(tx, ty);
  sendInputs([
    mousePacket(
      abs.dx,
      abs.dy,
      0,
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE_NOCOALESCE,
    ),
  ]);
  SetCursorPos(tx, ty);
  lastPos = { x: tx, y: ty };
}

function sendRelative(dx, dy) {
  const x = Math.round(dx) || 0;
  const y = Math.round(dy) || 0;
  if (!x && !y) return;
  sendInputs([mousePacket(x, y, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_MOVE_NOCOALESCE)]);
  if (lastPos) lastPos = { x: lastPos.x + x, y: lastPos.y + y };
}

export function focusWindowAt(x, y) {
  const now = Date.now();
  if (now - lastFocusAt < 250) return true;
  lastFocusAt = now;
  try {
    AllowSetForegroundWindow(0xffffffff);
    const hwnd = WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
    if (!hwnd) return false;
    const root = GetAncestor(hwnd, GA_ROOT) || hwnd;
    const fg = GetForegroundWindow();
    const curTid = GetCurrentThreadId();
    const fgTid = fg ? GetWindowThreadProcessId(fg, null) : 0;
    const targetTid = GetWindowThreadProcessId(root, null);
    if (fgTid && fgTid !== curTid) AttachThreadInput(curTid, fgTid, 1);
    if (targetTid && targetTid !== curTid) AttachThreadInput(curTid, targetTid, 1);
    if (IsIconic(root)) ShowWindow(root, 9);
    BringWindowToTop(root);
    SetForegroundWindow(root);
    if (fgTid && fgTid !== curTid) AttachThreadInput(curTid, fgTid, 0);
    if (targetTid && targetTid !== curTid) AttachThreadInput(curTid, targetTid, 0);
    return true;
  } catch {
    return false;
  }
}

export function moveMouse(dx, dy) {
  sendRelative(dx, dy);
}

export function click(button = "left", down = true, up = true) {
  const name = String(button || "left").toLowerCase();
  const packets = [];
  if (name === "x1" || name === "back" || name === "side1") {
    if (down) packets.push(mousePacket(0, 0, XBUTTON1, MOUSEEVENTF_XDOWN));
    if (up) packets.push(mousePacket(0, 0, XBUTTON1, MOUSEEVENTF_XUP));
  } else if (name === "x2" || name === "forward" || name === "side2") {
    if (down) packets.push(mousePacket(0, 0, XBUTTON2, MOUSEEVENTF_XDOWN));
    if (up) packets.push(mousePacket(0, 0, XBUTTON2, MOUSEEVENTF_XUP));
  } else {
    let flagsDown = MOUSEEVENTF_LEFTDOWN;
    let flagsUp = MOUSEEVENTF_LEFTUP;
    if (name === "right") {
      flagsDown = MOUSEEVENTF_RIGHTDOWN;
      flagsUp = MOUSEEVENTF_RIGHTUP;
    } else if (name === "middle") {
      flagsDown = MOUSEEVENTF_MIDDLEDOWN;
      flagsUp = MOUSEEVENTF_MIDDLEUP;
    }
    if (down) packets.push(mousePacket(0, 0, 0, flagsDown));
    if (up) packets.push(mousePacket(0, 0, 0, flagsUp));
  }
  sendInputs(packets);
  if (down) buttonsDown += 1;
  if (up) buttonsDown = Math.max(0, buttonsDown - 1);
}

export function scroll(dy) {
  const amount = Math.round(Number(dy) || 0);
  if (!amount) return;
  sendInputs([mousePacket(0, 0, amount, MOUSEEVENTF_WHEEL)]);
}

export function scrollH(dx) {
  const amount = Math.round(Number(dx) || 0);
  if (!amount) return;
  sendInputs([mousePacket(0, 0, amount, MOUSEEVENTF_HWHEEL)]);
}

export function setCursorPixel(x, y) {
  sendAbsolute(x, y);
}

export function moveAbs(nx, ny) {
  const pt = monitorPoint(null, nx, ny);
  sendAbsolute(pt.x, pt.y);
}

export function moveAbsOnMonitor(mon, nx, ny) {
  const pt = monitorPoint(mon, nx, ny);
  sendAbsolute(pt.x, pt.y);
}

// Games such as Roblox read the cursor once per rendered frame. When the move
// and the button arrive inside one frame (Roblox capped at 30 fps = 33 ms),
// the click lands where the cursor was on the previous frame, e.g. on the
// button tapped just before. So a tap moves first, waits at least one frame,
// then holds the button for at least one frame. Tunable through env vars.
function envMs(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
export const TAP_SETTLE_MS = envMs("PCREMOTE_TAP_SETTLE_MS", 50);
export const TAP_HOLD_MS = envMs("PCREMOTE_TAP_HOLD_MS", 45);

export async function tapAbsOnMonitor(mon, nx, ny, button = "left") {
  const pt = monitorPoint(mon, nx, ny);
  sendAbsolute(pt.x, pt.y);
  focusWindowAt(pt.x, pt.y);
  await wait(TAP_SETTLE_MS);
  click(button, true, false);
  await wait(TAP_HOLD_MS);
  click(button, false, true);
}

export async function beginDragOnMonitor(mon, nx, ny, button = "left") {
  buttonsDown = 0;
  const pt = monitorPoint(mon, nx, ny);
  sendAbsolute(pt.x, pt.y);
  focusWindowAt(pt.x, pt.y);
  await wait(TAP_SETTLE_MS);
  click(button, true, false);
}

export function moveDragOnMonitor(mon, nx, ny) {
  const pt = monitorPoint(mon, nx, ny);
  if (lastPos) sendRelative(pt.x - lastPos.x, pt.y - lastPos.y);
  else sendAbsolute(pt.x, pt.y);
  lastPos = { x: pt.x, y: pt.y };
}

export async function endDragOnMonitor(mon, nx, ny, button = "left") {
  moveDragOnMonitor(mon, nx, ny);
  await wait(TAP_SETTLE_MS);
  click(button, false, true);
  buttonsDown = 0;
}

export function describeKey(name) {
  const key = String(name || "").toLowerCase();
  const vk = NAMED_KEYS.get(key);
  if (!vk) return null;
  const scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) || vk;
  const extended = EXTENDED.has(vk);
  const flags = KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  return { key, vk, scan, extended, flagsDown: flags, flagsUp: flags | KEYEVENTF_KEYUP, shell: SHELL_KEYS.has(key) };
}

function sendKeyState(info, down) {
  // One injection only. Sending both SendInput and keybd_event made every
  // press/release land twice (F-keys double-tap, held WASD types again on lift).
  const flags = down ? info.flagsDown : info.flagsUp;
  sendInputs([keyPacket(info.vk, info.scan, flags)]);
}

export function keyDown(name) {
  const info = describeKey(name);
  if (!info) return false;
  sendKeyState(info, true);
  return true;
}

export function keyUp(name) {
  const info = describeKey(name);
  if (!info) return false;
  sendKeyState(info, false);
  return true;
}

export async function keyTap(name) {
  const info = describeKey(name);
  if (!info) return false;
  sendKeyState(info, true);
  if (info.shell) await wait(50);
  sendKeyState(info, false);
  return true;
}

export function comboPlan(keys) {
  return (Array.isArray(keys) ? keys : []).map((name) => describeKey(name)).filter(Boolean);
}

export function stickyComboPlan(keys) {
  const plan = comboPlan(keys);
  return {
    mods: plan.slice(0, -1).map((p) => p.key),
    tap: plan[plan.length - 1]?.key || "",
  };
}

export async function keyCombo(keys, opts = {}) {
  const plan = comboPlan(keys);
  if (!plan.length) return;
  if (opts.release) {
    for (const info of [...plan].reverse()) sendKeyState(info, false);
    return;
  }
  if (opts.hold) {
    const mods = plan.slice(0, -1);
    const last = plan[plan.length - 1];
    for (const info of mods) sendKeyState(info, true);
    await wait(40);
    if (last) {
      sendKeyState(last, true);
      await wait(50);
      sendKeyState(last, false);
    }
    return;
  }
  const names = plan.map((p) => p.key);
  const isAltTab = names.length === 2 && names[0] === "alt" && names[1] === "tab";
  const isWinTab = names.length === 2 && names[0] === "win" && names[1] === "tab";
  for (const info of plan) sendKeyState(info, true);
  await wait(isAltTab || isWinTab || plan.some((p) => p.shell) ? 60 : 20);
  for (const info of [...plan].reverse()) sendKeyState(info, false);
}

export function typeText(text) {
  const value = String(text || "");
  if (!value) return;
  const inputs = [];
  for (const char of value) {
    if (char === "\n") {
      const enter = describeKey("enter");
      inputs.push(keyPacket(0, enter.scan, enter.flagsDown), keyPacket(0, enter.scan, enter.flagsUp));
      continue;
    }
    const scan = char.codePointAt(0) || 0;
    inputs.push(keyPacket(0, scan, KEYEVENTF_UNICODE), keyPacket(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
  }
  for (let i = 0; i < inputs.length; i += 24) {
    sendInputs(inputs.slice(i, i + 24));
  }
}

export function media(action) {
  // Media keys MUST carry the E0-prefixed scancode + EXTENDEDKEY, exactly
  // like a physical media keyboard. The scancode low byte alone types
  // letters (0x2E=C, 0x30=B, 0x19=P, 0x20=D, 0x10=Q, 0x22=G), and a bare
  // 0xB4 with no scancode means Launch-Mail (mailto dialog) instead of
  // Play/Pause. Volume keys have no launch twins, which is why pure-VK
  // happened to work for them.
  const MEDIA_SCAN = {
    play: [0xb4, 0x22],
    pause: [0xb4, 0x22],
    next: [0xb0, 0x19],
    prev: [0xb1, 0x10],
    stop: [0xb3, 0x24],
    mute: [0xad, 0x20],
    volup: [0xaf, 0x30],
    voldown: [0xae, 0x2e],
  };
  const spec = MEDIA_SCAN[String(action || "").toLowerCase()];
  if (!spec) return keyTap(action);
  const down = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE;
  sendInputs([keyPacket(spec[0], spec[1], down)]);
  sendInputs([keyPacket(spec[0], spec[1], down | KEYEVENTF_KEYUP)]);
  return true;
}

export function peekAsyncKey(vk) {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

export function getClipboard() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
      { windowsHide: true, timeout: 2500 },
      (err, stdout) => resolve(err ? "" : String(stdout || "").slice(0, 20000)),
    );
  });
}

export function setClipboard(text) {
  return new Promise((resolve) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "Set-Clipboard -Value $input"],
      { windowsHide: true, timeout: 2500 },
      () => resolve(),
    );
    child.stdin.end(String(text || ""));
  });
}

export function lockWorkstation() {
  try {
    LockWorkStationFn();
  } catch {
    // fall back to the old child-process path if the direct call ever fails
    execFile("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true }, () => {});
  }
}

export function openTarget(target) {
  const value = String(target || "").trim();
  if (!value) return false;
  const allowedApps = {
    explorer: "explorer.exe",
    taskmgr: "taskmgr.exe",
    notepad: "notepad.exe",
    terminal: "wt.exe",
    browser: "https://www.google.com",
    settings: "ms-settings:",
    calc: "calc.exe",
  };
  if (allowedApps[value]) {
    execFile("cmd.exe", ["/c", "start", "", allowedApps[value]], { windowsHide: true }, () => {});
    return true;
  }
  if (/^https?:\/\//i.test(value)) {
    execFile("cmd.exe", ["/c", "start", "", value], { windowsHide: true }, () => {});
    return true;
  }
  return false;
}
