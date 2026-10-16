/**
 * Window thumbnails for the phone's window bar (Sill-style switcher).
 * PrintWindow(PW_RENDERFULLCONTENT) draws a window even when it is covered by
 * others; sharp shrinks it to a small JPEG. Minimized windows have nothing to
 * draw, so they get no thumbnail (the phone shows an icon instead).
 * Results are cached per window for CACHE_MS so polling stays cheap.
 */
import koffi from "koffi";
import sharp from "sharp";

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");
const dwmapi = koffi.load("dwmapi.dll");

const TRECT = koffi.struct("PcrThumbRECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const TBMIH = koffi.struct("PcrThumbBMIH", {
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
const IsWindow = user32.func("bool __stdcall IsWindow(intptr hwnd)");
const IsIconic = user32.func("bool __stdcall IsIconic(intptr hwnd)");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(intptr hwnd, _Out_ PcrThumbRECT *r)");
const GetDC = user32.func("intptr __stdcall GetDC(intptr hwnd)");
const ReleaseDC = user32.func("int32 __stdcall ReleaseDC(intptr hwnd, intptr hdc)");
const PrintWindow = user32.func("bool __stdcall PrintWindow(intptr hwnd, intptr hdc, uint32 flags)");
const CreateCompatibleDC = gdi32.func("intptr __stdcall CreateCompatibleDC(intptr hdc)");
const CreateCompatibleBitmap = gdi32.func("intptr __stdcall CreateCompatibleBitmap(intptr hdc, int32 cx, int32 cy)");
const SelectObject = gdi32.func("intptr __stdcall SelectObject(intptr hdc, intptr obj)");
const DeleteObject = gdi32.func("bool __stdcall DeleteObject(intptr obj)");
const DeleteDC = gdi32.func("bool __stdcall DeleteDC(intptr hdc)");
const GetDIBits = gdi32.func(
  "int32 __stdcall GetDIBits(intptr hdc, intptr hbm, uint32 start, uint32 lines, void *bits, _Inout_ PcrThumbBMIH *info, uint32 usage)",
);
const DwmGetWindowAttributeRect = dwmapi.func(
  "int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ PcrThumbRECT *value, uint32 size)",
);

const PW_RENDERFULLCONTENT = 2;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const THUMB_W = 192;
const CACHE_MS = 1800;
const MAX_SIDE = 4096;
const cache = new Map(); // id -> { at, data }

function grab(h) {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  GetWindowRect(h, r);
  const w = r.right - r.left;
  const hgt = r.bottom - r.top;
  if (w < 8 || hgt < 8 || w > MAX_SIDE || hgt > MAX_SIDE) return null;
  // Crop the invisible resize border Windows 10/11 adds around the frame.
  const fr = { left: 0, top: 0, right: 0, bottom: 0 };
  const hasFrame = DwmGetWindowAttributeRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, fr, koffi.sizeof(TRECT)) === 0;
  const screen = GetDC(0);
  const mem = CreateCompatibleDC(screen);
  const bmp = CreateCompatibleBitmap(screen, w, hgt);
  const old = SelectObject(mem, bmp);
  let pixels = null;
  try {
    if (PrintWindow(h, mem, PW_RENDERFULLCONTENT)) {
      SelectObject(mem, old);
      const info = { biSize: koffi.sizeof(TBMIH), biWidth: w, biHeight: -hgt, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
      const buf = Buffer.alloc(w * hgt * 4);
      if (GetDIBits(mem, bmp, 0, hgt, buf, info, 0)) pixels = buf;
    } else {
      SelectObject(mem, old);
    }
  } finally {
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(0, screen);
  }
  if (!pixels) return null;
  let crop = { left: 0, top: 0, width: w, height: hgt };
  if (hasFrame) {
    const left = Math.max(0, fr.left - r.left);
    const top = Math.max(0, fr.top - r.top);
    const width = Math.min(w - left, fr.right - fr.left);
    const height = Math.min(hgt - top, fr.bottom - fr.top);
    if (width > 8 && height > 8) crop = { left, top, width, height };
  }
  return { pixels, w, h: hgt, crop };
}

/** Small JPEG (base64) of one window, or null (minimized, gone, or failed). */
export async function windowThumb(id) {
  const h = Number(id) || 0;
  if (!h || !IsWindow(h) || IsIconic(h)) return null;
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  let data = null;
  try {
    const g = grab(h);
    if (g) {
      const jpg = await sharp(g.pixels, { raw: { width: g.w, height: g.h, channels: 4 } })
        .extract(g.crop)
        .removeAlpha()
        .recomb([
          [0, 0, 1],
          [0, 1, 0],
          [1, 0, 0],
        ])
        .resize({ width: THUMB_W, withoutEnlargement: true })
        .jpeg({ quality: 55 })
        .toBuffer();
      data = jpg.toString("base64");
    }
  } catch {
    data = null;
  }
  cache.set(h, { at: Date.now(), data });
  if (cache.size > 80) {
    for (const k of cache.keys()) {
      if (!IsWindow(k)) cache.delete(k);
    }
  }
  return data;
}

/** Thumbnails for the first `max` windows of a list: { [id]: base64 }. */
export async function windowThumbs(list, max = 12) {
  const out = {};
  for (const w of (list || []).slice(0, max)) {
    if (w.min) continue;
    const data = await windowThumb(w.id);
    if (data) out[w.id] = data;
  }
  return out;
}
