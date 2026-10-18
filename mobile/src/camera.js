/**
 * Camera math for the Look viewer (pure, no React). Unit-tested in
 * camera.test.js and also used inside Reanimated worklets (hence the
 * "worklet" directives, which are plain strings outside a worklet build).
 *
 * Model: the whole monitor is a "canvas" that fits the view (contain). The
 * camera is a transform of that canvas: scale s (1 = Fit) and translation
 * tx/ty in view px, applied around the view centre:
 *   screen = viewCentre + t + s * (canvasPoint - canvasCentre)
 * Every streamed frame is drawn ON the canvas at the rect its own header
 * says it covers, so the camera never has to "rebase" when a sharper crop
 * arrives: the picture just gets sharper in place. That removes the jump
 * after every pinch/pan of the old crop-commit model.
 */

export const MAX_ZOOM = 8;
export const MIN_ZOOM = 1;

/** Canvas (whole monitor) fitted into the view, at camera identity. */
export function fitCanvas(vw, vh, aspect) {
  "worklet";
  const w = Math.max(1, vw);
  const h = Math.max(1, vh);
  const a = aspect > 0 ? aspect : w / h;
  let bw = w;
  let bh = w / a;
  if (bh > h) {
    bh = h;
    bw = h * a;
  }
  return { bw, bh, ox: (w - bw) / 2, oy: (h - bh) / 2 };
}

/** Largest translation that still keeps the canvas covering the view. */
export function maxPan(s, bw, bh, vw, vh) {
  "worklet";
  return {
    mx: Math.max(0, (s * bw - vw) / 2),
    my: Math.max(0, (s * bh - vh) / 2),
  };
}

export function clampScale(s) {
  "worklet";
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s));
}

/** Hard clamp of a camera to valid scale + covering translation. */
export function clampCam(cam, bw, bh, vw, vh) {
  "worklet";
  const s = clampScale(cam.s);
  const { mx, my } = maxPan(s, bw, bh, vw, vh);
  return {
    s,
    tx: Math.max(-mx, Math.min(mx, cam.tx)),
    ty: Math.max(-my, Math.min(my, cam.ty)),
  };
}

/** Soft limit for in-gesture overscroll: past the edge, motion is damped. */
export function rubber(v, limit, dim) {
  "worklet";
  if (v > limit) return limit + (v - limit) * 0.35 * (dim / (dim + (v - limit)));
  if (v < -limit) return -limit - (-limit - v) * 0.35 * (dim / (dim + (-limit - v)));
  return v;
}

/**
 * Pinch + pan in one step. start = camera when the gesture began, f0 = focal
 * point (view px) at start, f = focal point now, k = pinch scale factor
 * since start. The canvas point that was under f0 stays under f, so moving
 * the fingers pans while spreading them zooms.
 */
export function pinchCam(start, f0, f, k, vw, vh) {
  "worklet";
  const s0 = Math.max(0.01, start.s);
  const s = clampScale(s0 * k);
  const cx = vw / 2;
  const cy = vh / 2;
  const px = (f0.x - cx - start.tx) / s0;
  const py = (f0.y - cy - start.ty) / s0;
  return { s, tx: f.x - cx - s * px, ty: f.y - cy - s * py };
}

/** Zoom by factor k around a view point (double tap, +/- buttons). */
export function zoomAt(cam, k, p, vw, vh) {
  "worklet";
  return pinchCam(cam, p, p, k, vw, vh);
}

/** View px -> monitor-normalized point (may be outside 0..1). */
export function viewToMonitor(x, y, cam, fit, vw, vh) {
  "worklet";
  const s = Math.max(0.01, cam.s);
  return {
    x: 0.5 + (x - vw / 2 - cam.tx) / (s * fit.bw),
    y: 0.5 + (y - vh / 2 - cam.ty) / (s * fit.bh),
  };
}

/** Monitor-normalized point -> view px. */
export function monitorToView(mx, my, cam, fit, vw, vh) {
  "worklet";
  return {
    x: vw / 2 + cam.tx + cam.s * (mx - 0.5) * fit.bw,
    y: vh / 2 + cam.ty + cam.s * (my - 0.5) * fit.bh,
  };
}

/** Monitor rect the view currently shows (clamped to the monitor). */
export function visibleRect(cam, fit, vw, vh) {
  "worklet";
  const a = viewToMonitor(0, 0, cam, fit, vw, vh);
  const b = viewToMonitor(vw, vh, cam, fit, vw, vh);
  const x0 = Math.max(0, Math.min(1, a.x));
  const y0 = Math.max(0, Math.min(1, a.y));
  const x1 = Math.max(0, Math.min(1, b.x));
  const y1 = Math.max(0, Math.min(1, b.y));
  return { x: x0, y: y0, w: Math.max(0.001, x1 - x0), h: Math.max(0.001, y1 - y0) };
}

/** Camera that shows monitor point (cx, cy) at the view centre at scale s. */
export function camFor(s, cx, cy, fit, vw, vh) {
  "worklet";
  const sc = clampScale(s);
  return clampCam({ s: sc, tx: -(cx - 0.5) * sc * fit.bw, ty: -(cy - 0.5) * sc * fit.bh }, fit.bw, fit.bh, vw, vh);
}

/**
 * Live typing with the phone keyboard up: the view is short, so zoom in until
 * about TYPE_SPAN of the monitor width fills it and centre the point where the
 * text goes (the last click). Never zooms out from a closer camera.
 */
export const TYPE_SPAN = 0.45;
export function typingCam(cur, cx, cy, fit, vw, vh) {
  const want = vw / (TYPE_SPAN * Math.max(1, fit.bw));
  const s = Math.max(cur?.s || 1, want);
  return camFor(s, cx, cy, fit, vw, vh);
}

/**
 * Camera that frames a monitor-normalized rect {x, y, w, h} (single-window
 * stream): the whole rect fits the view, centred. Clamped like any camera.
 */
export function camForRect(r, fit, vw, vh) {
  const w = Math.max(0.01, r.w);
  const h = Math.max(0.01, r.h);
  const s = Math.min(vw / (w * fit.bw), vh / (h * fit.bh));
  return camFor(s, r.x + w / 2, r.y + h / 2, fit, vw, vh);
}

/** Resolution-independent camera (shared across tabs whose views differ). */
export function camToNorm(cam, fit, vw, vh) {
  const c = viewToMonitor(vw / 2, vh / 2, cam, fit, vw, vh);
  return { z: cam.s, cx: c.x, cy: c.y };
}

export function normToCam(n, fit, vw, vh) {
  if (!n) return { s: 1, tx: 0, ty: 0 };
  return camFor(n.z || 1, Number.isFinite(n.cx) ? n.cx : 0.5, Number.isFinite(n.cy) ? n.cy : 0.5, fit, vw, vh);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Region to ask the PC for: the visible rect grown by `pad` on each axis. */
export function expandRegion(vis, pad) {
  const w = Math.min(1, vis.w * (1 + pad));
  const h = Math.min(1, vis.h * (1 + pad));
  return {
    x: clamp(vis.x - (w - vis.w) / 2, 0, 1 - w),
    y: clamp(vis.y - (h - vis.h) / 2, 0, 1 - h),
    w,
    h,
  };
}

/**
 * Can the region already requested still serve this view? True while it
 * covers the view and is not so much bigger that the view looks soft.
 * Mirrors runtime/agent/src/viewmap.js regionStillUsable.
 */
export function regionCovers(region, vis, maxStretch = 2.4) {
  if (!region) return false;
  const slack = 0.004;
  const covers =
    vis.x >= region.x - slack &&
    vis.y >= region.y - slack &&
    vis.x + vis.w <= region.x + region.w + slack &&
    vis.y + vis.h <= region.y + region.h + slack;
  return covers && region.w <= vis.w * maxStretch + slack && region.h <= vis.h * maxStretch + slack;
}

/** At (or near) Fit the whole monitor is requested, never a sliver. */
export function regionFor(vis, pad) {
  if (vis.w > 0.9 && vis.h > 0.9) return { x: 0, y: 0, w: 1, h: 1 };
  return expandRegion(vis, pad);
}

/**
 * Frame headers carry the crop quantized to 1/255. Snap it back to the exact
 * region we asked for (newest first) so frames sit on the canvas pixel-exact.
 */
export function resolveCrop(header, sent, tol = 0.0045) {
  if (!header) return { x: 0, y: 0, w: 1, h: 1 };
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const c = sent[i];
    if (
      Math.abs(c.x - header.x) <= tol &&
      Math.abs(c.y - header.y) <= tol &&
      Math.abs(c.w - header.w) <= tol &&
      Math.abs(c.h - header.h) <= tol
    ) {
      return { ...c };
    }
  }
  return { ...header };
}
