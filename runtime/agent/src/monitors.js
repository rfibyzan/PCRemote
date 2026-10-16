import koffi from "koffi";
import { CURSOR_IDS, shapeOf } from "./pointerstate.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const screenshot = require("screenshot-desktop");

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");

const RECT = koffi.struct("RECT", {
  left: "int32",
  top: "int32",
  right: "int32",
  bottom: "int32",
});

const CursorPoint = koffi.struct("CursorPoint", {
  x: "int32",
  y: "int32",
});

const CURSORINFO = koffi.struct("CURSORINFO", {
  cbSize: "uint32",
  flags: "uint32",
  hCursor: "void *",
  ptScreenPos: CursorPoint,
});

const MONITORINFOEX = koffi.struct("MONITORINFOEXW", {
  cbSize: "uint32",
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: "uint32",
  szDevice: koffi.array("uint16", 32),
});

const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
  biSize: "uint32",
  biWidth: "int32",
  biHeight: "int32",
  biPlanes: "uint16",
  biBitCount: "uint16",
  biCompression: "uint32",
  biSizeImage: "uint32",
  biXPelsPerMeter: "int32",
  biYPelsPerMeter: "int32",
  biClrUsed: "uint32",
  biClrImportant: "uint32",
});

const MonitorEnumProc = koffi.proto(
  "bool __stdcall MonitorEnumProc(void *hMonitor, void *hdc, RECT *lprcMonitor, intptr dwData)",
);

const EnumDisplayMonitors = user32.func(
  "bool __stdcall EnumDisplayMonitors(void *hdc, void *lprcClip, MonitorEnumProc *lpfnEnum, intptr dwData)",
);
const GetMonitorInfoW = user32.func("bool __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ MONITORINFOEXW *lpmi)");
const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ CursorPoint *lpPoint)");
const GetCursorInfo = user32.func("bool __stdcall GetCursorInfo(_Inout_ CURSORINFO *pci)");
const LoadCursorW = user32.func("void * __stdcall LoadCursorW(void *hInstance, uintptr lpCursorName)");
const GetDC = user32.func("void * __stdcall GetDC(void *hWnd)");
const ReleaseDC = user32.func("int32 __stdcall ReleaseDC(void *hWnd, void *hdc)");
const CreateCompatibleDC = gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)");
const CreateCompatibleBitmap = gdi32.func("void * __stdcall CreateCompatibleBitmap(void *hdc, int32 cx, int32 cy)");
const SelectObject = gdi32.func("void * __stdcall SelectObject(void *hdc, void *hgdiobj)");
const BitBlt = gdi32.func(
  "bool __stdcall BitBlt(void *hdc, int32 x, int32 y, int32 cx, int32 cy, void *hdcSrc, int32 x1, int32 y1, uint32 rop)",
);
const StretchBlt = gdi32.func(
  "bool __stdcall StretchBlt(void *hdcDest, int32 xDest, int32 yDest, int32 wDest, int32 hDest, void *hdcSrc, int32 xSrc, int32 ySrc, int32 wSrc, int32 hSrc, uint32 rop)",
);
const SetStretchBltMode = gdi32.func("int32 __stdcall SetStretchBltMode(void *hdc, int32 mode)");
const DeleteObject = gdi32.func("bool __stdcall DeleteObject(void *ho)");
const DeleteDC = gdi32.func("bool __stdcall DeleteDC(void *hdc)");
const GetDIBits = gdi32.func(
  "int32 __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, _Inout_ BITMAPINFOHEADER *info, uint32 usage)",
);

const SRCCOPY = 0x00cc0020;
const COLORONCOLOR = 3;
const MONITORINFOF_PRIMARY = 1;

let monitorCache = { at: 0, list: [] };

function decodeWide(chars) {
  let out = "";
  for (const code of chars) {
    if (!code) break;
    out += String.fromCharCode(code);
  }
  return out.replace(/^\\\\\.\\/, "");
}

export function listMonitors() {
  if (monitorCache.list.length && Date.now() - monitorCache.at < 2000) return monitorCache.list;
  const found = [];
  const callback = koffi.register((hMonitor) => {
    const info = {
      cbSize: koffi.sizeof(MONITORINFOEX),
      rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
      rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
      dwFlags: 0,
      szDevice: Array(32).fill(0),
    };
    GetMonitorInfoW(hMonitor, info);
    const m = info.rcMonitor;
    found.push({
      left: m.left,
      top: m.top,
      right: m.right,
      bottom: m.bottom,
      w: m.right - m.left,
      h: m.bottom - m.top,
      primary: Boolean(info.dwFlags & MONITORINFOF_PRIMARY),
      device: decodeWide(info.szDevice),
    });
    return true;
  }, koffi.pointer(MonitorEnumProc));

  EnumDisplayMonitors(null, null, callback, 0);
  koffi.unregister(callback);

  found.sort((a, b) => a.left - b.left || a.top - b.top);
  monitorCache = {
    at: Date.now(),
    list: found.map((mon, index) => ({
      id: index,
      name: mon.primary ? `Monitor ${index + 1} (main)` : `Monitor ${index + 1}`,
      ...mon,
    })),
  };
  return monitorCache.list;
}

// ---- DXGI outputs (for ffmpeg ddagrab) -----------------------------------
// ddagrab picks a monitor by DXGI output index on the default adapter, which
// is not guaranteed to follow EnumDisplayMonitors order. Ask DXGI directly
// (tiny COM-by-vtable calls through koffi) for each output's desktop rect so
// video.js can map the monitor rect it streams to output_idx + offsets.

const DXGI_OUTPUT_DESC = koffi.struct("DXGI_OUTPUT_DESC", {
  DeviceName: koffi.array("uint16", 32),
  DesktopCoordinates: RECT,
  AttachedToDesktop: "int32",
  Rotation: "uint32",
  Monitor: "void *",
});
const ComRelease = koffi.proto("uint32 __stdcall ComRelease(void *self)");
const FactoryEnumAdapters1 = koffi.proto("int32 __stdcall FactoryEnumAdapters1(void *self, uint32 idx, _Out_ void **adapter)");
const AdapterEnumOutputs = koffi.proto("int32 __stdcall AdapterEnumOutputs(void *self, uint32 idx, _Out_ void **output)");
const OutputGetDesc = koffi.proto("int32 __stdcall OutputGetDesc(void *self, _Out_ DXGI_OUTPUT_DESC *desc)");

// Vtable slots: IUnknown 0-2, IDXGIObject 3-6, then the interface's own.
const VT_RELEASE = 2;
const VT_FACTORY1_ENUMADAPTERS1 = 12; // IDXGIFactory 7-11, IDXGIFactory1 12-13
const VT_ADAPTER_ENUMOUTPUTS = 7;
const VT_OUTPUT_GETDESC = 7;

let dxgiApi = null;
function dxgi() {
  if (dxgiApi === null) {
    try {
      const lib = koffi.load("dxgi.dll");
      dxgiApi = { CreateDXGIFactory1: lib.func("int32 __stdcall CreateDXGIFactory1(void *riid, _Out_ void **factory)") };
    } catch {
      dxgiApi = false;
    }
  }
  return dxgiApi || null;
}

function guidBytes(text) {
  const h = text.replace(/[{}-]/g, "");
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), "hex").copy(b, 8);
  return b;
}
const IID_IDXGIFactory1 = guidBytes("770aae78-f26f-4dba-a829-253c83d1b387");

function comMethod(obj, slot) {
  const vtbl = koffi.decode(obj, "void *");
  return koffi.decode(vtbl, slot * koffi.sizeof("void *"), "void *");
}
function comRelease(obj) {
  if (!obj) return;
  try {
    koffi.call(comMethod(obj, VT_RELEASE), ComRelease, obj);
  } catch {
    // best effort
  }
}

let dxgiCache = { at: 0, list: [] };

/**
 * Outputs of DXGI adapter 0 (the adapter ffmpeg's ddagrab uses unless told
 * otherwise): [{ idx, device, left, top, right, bottom, rotation, attached }].
 * Empty list when DXGI is unavailable; never throws.
 */
export function listDxgiOutputs() {
  if (Date.now() - dxgiCache.at < 2000) return dxgiCache.list;
  const list = [];
  const api = dxgi();
  let factory = null;
  let adapter = null;
  try {
    if (api) {
      const fOut = [null];
      if (api.CreateDXGIFactory1(IID_IDXGIFactory1, fOut) >= 0 && fOut[0]) {
        factory = fOut[0];
        const aOut = [null];
        if (koffi.call(comMethod(factory, VT_FACTORY1_ENUMADAPTERS1), FactoryEnumAdapters1, factory, 0, aOut) >= 0 && aOut[0]) {
          adapter = aOut[0];
          for (let idx = 0; idx < 16; idx += 1) {
            const oOut = [null];
            // DXGI_ERROR_NOT_FOUND (negative HRESULT) ends the list.
            if (koffi.call(comMethod(adapter, VT_ADAPTER_ENUMOUTPUTS), AdapterEnumOutputs, adapter, idx, oOut) < 0 || !oOut[0]) break;
            const output = oOut[0];
            try {
              const desc = {};
              if (koffi.call(comMethod(output, VT_OUTPUT_GETDESC), OutputGetDesc, output, desc) >= 0) {
                const r = desc.DesktopCoordinates;
                list.push({
                  idx,
                  device: decodeWide(desc.DeviceName),
                  left: r.left,
                  top: r.top,
                  right: r.right,
                  bottom: r.bottom,
                  rotation: desc.Rotation,
                  attached: Boolean(desc.AttachedToDesktop),
                });
              }
            } finally {
              comRelease(output);
            }
          }
        }
      }
    }
  } catch {
    list.length = 0;
  } finally {
    comRelease(adapter);
    comRelease(factory);
  }
  dxgiCache = { at: Date.now(), list };
  return list;
}

export function cursorPos() {
  const point = { x: 0, y: 0 };
  GetCursorPos(point);
  return point;
}

function captureLooksBlank(pixels) {
  let max = 0;
  const step = Math.max(4, Math.floor(pixels.length / 4096) * 4 || 4);
  for (let i = 0; i < pixels.length; i += step) {
    const v = pixels[i];
    if (v > max) max = v;
    if (max > 12) return false;
  }
  return true;
}

function blitScreen(left, top, width, height, outW, outH) {
  const screenDc = GetDC(null);
  if (!screenDc) throw new Error("no screen dc");
  const memDc = CreateCompatibleDC(screenDc);
  const bmp = CreateCompatibleBitmap(screenDc, outW, outH);
  const old = SelectObject(memDc, bmp);
  let copied;
  if (outW === width && outH === height) {
    copied = BitBlt(memDc, 0, 0, outW, outH, screenDc, left, top, SRCCOPY);
  } else {
    SetStretchBltMode(memDc, COLORONCOLOR);
    copied = StretchBlt(memDc, 0, 0, outW, outH, screenDc, left, top, width, height, SRCCOPY);
  }
  SelectObject(memDc, old);
  if (!copied) {
    DeleteObject(bmp);
    DeleteDC(memDc);
    ReleaseDC(null, screenDc);
    throw new Error("bitblt failed");
  }
  const header = {
    biSize: koffi.sizeof(BITMAPINFOHEADER),
    biWidth: outW,
    biHeight: -outH,
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: 0,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  };
  const pixels = Buffer.alloc(outW * outH * 4);
  const got = GetDIBits(memDc, bmp, 0, outH, pixels, header, 0);
  DeleteObject(bmp);
  DeleteDC(memDc);
  ReleaseDC(null, screenDc);
  // Only the API return values mean failure. An all-black result is reported as
  // a hint, never an error: a monitor showing nothing really is black, and
  // treating that as a failure used to fall through to a whole-desktop
  // screenshot and display the wrong monitor entirely.
  if (!got) throw new Error("getdibits failed");
  return { pixels, width: outW, height: outH, blank: captureLooksBlank(pixels) };
}

function captureGdi(left, top, width, height, destW, destH) {
  const srcW = Math.max(1, Math.round(width));
  const srcH = Math.max(1, Math.round(height));
  const outW = Math.max(1, Math.round(destW || srcW));
  const outH = Math.max(1, Math.round(destH || srcH));
  const scaled = blitScreen(left, top, srcW, srcH, outW, outH);
  if (!scaled.blank || (outW === srcW && outH === srcH)) return scaled;
  // Scaled StretchBlt occasionally comes back empty on some drivers. Retry at
  // native size to tell that apart from a screen that is genuinely black.
  const native = blitScreen(left, top, srcW, srcH, srcW, srcH);
  return native.blank ? scaled : native;
}

let captureChain = Promise.resolve();
function withCaptureLock(fn) {
  const run = captureChain.then(fn, fn);
  captureChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** A believable black frame, used when we cannot honestly capture a monitor. */
function blackFrame(w, h) {
  return sharp({
    create: {
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .jpeg({ quality: 40 })
    .toBuffer();
}

/**
 * Last resort when GDI cannot capture. `screenshot-desktop` grabs only the
 * primary display on Windows, so cropping it by virtual-desktop offsets would
 * hand back a piece of the main monitor while claiming to be another screen.
 * Showing the wrong desktop is worse than showing nothing, so anything we
 * cannot positively identify comes back black.
 */
async function captureFallback(mon) {
  const img = await screenshot({ format: "jpg" });
  const buf = Buffer.isBuffer(img) ? img : Buffer.from(img);
  const meta = await sharp(buf).metadata();
  const shotW = meta.width || 0;
  const shotH = meta.height || 0;
  const monitors = listMonitors();
  const virtualLeft = Math.min(...monitors.map((m) => m.left));
  const virtualTop = Math.min(...monitors.map((m) => m.top));
  const virtualW = Math.max(...monitors.map((m) => m.right)) - virtualLeft;
  const virtualH = Math.max(...monitors.map((m) => m.bottom)) - virtualTop;

  // Case 1: we really did get the whole virtual desktop, so the offsets are valid.
  if (shotW >= virtualW - 2 && shotH >= virtualH - 2) {
    return sharp(buf)
      .extract({
        left: Math.max(0, mon.left - virtualLeft),
        top: Math.max(0, mon.top - virtualTop),
        width: Math.min(mon.w, shotW - Math.max(0, mon.left - virtualLeft)),
        height: Math.min(mon.h, shotH - Math.max(0, mon.top - virtualTop)),
      })
      .toBuffer();
  }

  // Case 2: a single-display shot that matches the monitor we were asked for.
  if (Math.abs(shotW - mon.w) <= 2 && Math.abs(shotH - mon.h) <= 2) return buf;

  return blackFrame(mon.w, mon.h);
}

// Must stay in lockstep with PRESET_BASE in app/src/qualityPrefs.ts.
// `width` is a ceiling; see resolveDestWidth for how the real size is chosen.
export const QUALITY = {
  lite: { width: 560, quality: 18, fps: 6 },
  low: { width: 800, quality: 26, fps: 13 },
  med: { width: 800, quality: 26, fps: 13 },
  // Zoomed all the way out, a 2560px desktop cannot show readable text on a
  // phone at any width, so the un-zoomed view stays deliberately modest and the
  // resolution budget is spent on the zoomed-in crop instead.
  high: { width: 1000, quality: 40, fps: 22 },
  super: { width: 1000, quality: 40, fps: 22 },
};

export function applyTune(base, tune = {}) {
  const qs = Math.max(-5, Math.min(8, Math.round(Number(tune.qStep) || 0)));
  const fs = Math.max(-5, Math.min(10, Math.round(Number(tune.fpsStep) || 0)));
  return {
    width: Math.max(320, Math.min(1920, Math.round(base.width))),
    quality: Math.max(18, Math.min(92, Math.round(base.quality + qs * 8))),
    fps: Math.max(1, Math.min(30, Math.round(base.fps + fs * 2))),
  };
}

export function encodeProfile(qualityKey = "low", remote = false, cropped = false, tune = {}) {
  const key = qualityKey === "super" ? "high" : qualityKey === "high" ? "high" : qualityKey === "lite" ? "lite" : "low";
  let base;
  if (key === "lite") {
    if (cropped) base = remote ? { width: 560, quality: 20, fps: 4 } : { width: 640, quality: 22, fps: 6 };
    else base = remote ? { width: 480, quality: 18, fps: 4 } : QUALITY.lite;
  } else if (key === "high") {
    if (cropped) base = remote ? { width: 1600, quality: 44, fps: 14 } : { width: 1920, quality: 44, fps: 22 };
    else base = remote ? { width: 900, quality: 40, fps: 14 } : QUALITY.high;
  } else if (cropped) {
    base = remote ? { width: 900, quality: 30, fps: 8 } : { width: 1100, quality: 30, fps: 13 };
  } else {
    base = remote ? { width: 720, quality: 26, fps: 8 } : QUALITY.low;
  }
  const q = applyTune(base, tune);
  // The phone may only tighten the resolution ceiling, never raise it, so the
  // PC's own budget for this preset is always the upper bound.
  if (Number(tune.width) >= 320) {
    q.width = Math.min(q.width, Math.max(320, Math.min(1920, Math.round(Number(tune.width)))));
  }
  if (Number(tune.jpeg) >= 18) q.quality = Math.max(18, Math.min(92, Math.round(Number(tune.jpeg))));
  if (Number(tune.fps) >= 1) q.fps = Math.max(1, Math.min(30, Math.round(Number(tune.fps))));
  return q;
}

/**
 * Pick the encode width. Three separate ceilings apply, and the smallest wins:
 * the quality preset (the user's data budget), the phone's real pixel width
 * (detail beyond it cannot be displayed), and the captured region's own size
 * (upscaling on the PC would only waste bytes). When the user zooms in, the
 * region shrinks below the other two and the crop gets encoded near 1:1, which
 * is the only way text on a 2560px desktop becomes readable on a phone.
 */
export function resolveDestWidth(capWidth, viewPx, regionWidth) {
  const cap = Math.max(320, Math.min(1920, Math.round(capWidth) || 320));
  const phone = Math.round(Number(viewPx) || 0);
  const ceiling = phone >= 320 ? Math.min(cap, phone) : cap;
  return Math.max(1, Math.min(ceiling, Math.round(regionWidth)));
}

export function applyCrop(target, crop) {
  if (!crop || !(crop.w < 0.995 || crop.h < 0.995 || crop.x > 0.004 || crop.y > 0.004)) return target;
  const x = Math.max(0, Math.min(1, Number(crop.x) || 0));
  const y = Math.max(0, Math.min(1, Number(crop.y) || 0));
  const w = Math.max(0.02, Math.min(1 - x, Number(crop.w) || 1));
  const h = Math.max(0.02, Math.min(1 - y, Number(crop.h) || 1));
  return {
    left: Math.round(target.left + x * target.w),
    top: Math.round(target.top + y * target.h),
    w: Math.max(16, Math.round(w * target.w)),
    h: Math.max(16, Math.round(h * target.h)),
  };
}

export async function captureMonitor(mon, qualityKey = "low", all = false, remote = false, crop = null, tune = {}) {
  return withCaptureLock(() => grabMonitor(mon, qualityKey, all, remote, crop, tune));
}

async function grabMonitor(mon, qualityKey, all, remote, crop, tune) {
  const cropped = Boolean(crop && (crop.w < 0.995 || crop.h < 0.995 || crop.x > 0.004 || crop.y > 0.004));
  const q = encodeProfile(qualityKey, remote, cropped, tune);
  const monitors = listMonitors();
  const full = all
    ? {
        left: Math.min(...monitors.map((m) => m.left)),
        top: Math.min(...monitors.map((m) => m.top)),
        w: Math.max(...monitors.map((m) => m.right)) - Math.min(...monitors.map((m) => m.left)),
        h: Math.max(...monitors.map((m) => m.bottom)) - Math.min(...monitors.map((m) => m.top)),
      }
    : mon;
  const target = applyCrop(full, crop);

  // Bandwidth first. Sharpening costs roughly 20% more bytes and full colour
  // detail roughly 30%, so they stay off for the cheap presets and switch on
  // where the user has asked for legible text. Thresholds sit just under the
  // Read preset's quality so that preset gets the text treatment.
  const amount = Math.max(0, Math.min(1, (q.quality - 38) / 54));
  const jpegOpts = {
    quality: q.quality,
    mozjpeg: true,
    progressive: false,
    chromaSubsampling: q.quality >= 56 ? "4:4:4" : "4:2:0",
    optimizeScans: false,
    trellisQuantisation: true,
    overshootDeringing: false,
  };
  const sharpenOpts =
    q.quality >= 38
      ? { sigma: 0.6 + amount * 0.7, m1: 0.8 + amount * 0.7, m2: 0.35 + amount * 0.45 }
      : null;
  const destW = resolveDestWidth(q.width, tune.viewPx, target.w);
  const destH = Math.max(1, Math.round((target.h * destW) / Math.max(1, target.w)));

  let raw;
  try {
    const grabbed = captureGdi(target.left, target.top, target.w, target.h, destW, destH);
    let pipeline = sharp(grabbed.pixels, {
      raw: { width: grabbed.width, height: grabbed.height, channels: 4 },
    })
      .removeAlpha()
      .recomb([
        [0, 0, 1],
        [0, 1, 0],
        [1, 0, 0],
      ]);
    if (grabbed.width !== destW) {
      pipeline = pipeline.resize({ width: destW, withoutEnlargement: true, kernel: "lanczos3" });
    }
    if (sharpenOpts) pipeline = pipeline.sharpen(sharpenOpts);
    raw = await pipeline.jpeg(jpegOpts).toBuffer();
  } catch {
    const shot = await Promise.race([
      all ? screenshot({ format: "jpg" }) : captureFallback(target),
      new Promise((_, reject) => setTimeout(() => reject(new Error("screenshot timeout")), 2500)),
    ]);
    let pipeline = sharp(shot).resize({ width: destW, withoutEnlargement: true, kernel: "lanczos3" });
    if (sharpenOpts) pipeline = pipeline.sharpen(sharpenOpts);
    raw = await pipeline.jpeg(jpegOpts).toBuffer();
  }
  return raw;
}

export function frameFingerprint(buf) {
  if (!buf || !buf.length) return 0;
  let h = 2166136261;
  const step = Math.max(1, (buf.length / 1024) | 0);
  for (let i = 0; i < buf.length; i += step) h = Math.imul(h ^ buf[i], 16777619);
  return (h ^ buf.length) >>> 0;
}

// Standard system cursor handles are shared, so LoadCursor(NULL, IDC_x)
// returns the same handle GetCursorInfo reports while that shape is showing.
let cursorTable = null;
function addr(p) {
  try {
    return p ? String(koffi.address(p)) : null;
  } catch {
    return null;
  }
}
/** {visible, handle} of the current Windows cursor ("none" when hidden, e.g. games). */
export function cursorShape() {
  if (!cursorTable) {
    cursorTable = new Map();
    for (const [id, name] of Object.entries(CURSOR_IDS)) {
      const a = addr(LoadCursorW(null, Number(id)));
      if (a && !cursorTable.has(a)) cursorTable.set(a, name);
    }
  }
  try {
    const info = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: null, ptScreenPos: { x: 0, y: 0 } };
    if (!GetCursorInfo(info)) return "arrow";
    return shapeOf((info.flags & 1) === 1, addr(info.hCursor), cursorTable);
  } catch {
    return "arrow";
  }
}

export function cursorOnMonitor(mon) {
  const pos = cursorPos();
  if (!mon) return { cx: 0.5, cy: 0.5, on: false };
  const on = pos.x >= mon.left && pos.x < mon.right && pos.y >= mon.top && pos.y < mon.bottom;
  return {
    cx: (pos.x - mon.left) / Math.max(1, mon.w),
    cy: (pos.y - mon.top) / Math.max(1, mon.h),
    on,
  };
}
