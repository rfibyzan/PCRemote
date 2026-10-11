/**
 * Pure zoom math for the Look-mode viewer (no React / RN), unit-tested in
 * zoom.test.js. Crops are monitor-normalized rects {x,y,w,h} in 0..1.
 * The live transform {s,tx,ty} scales the displayed frame around the view
 * centre; total zoom on screen = s / crop.w.
 */

/** Single zoom cap shared by pinch, slider, +/- buttons and crop clamping. */
export const MAX_ZOOM = 8;
export const MIN_CROP = 1 / MAX_ZOOM;

/**
 * Frame headers carry the crop quantized to 1/255 per field, so a frame
 * "matches" the committed crop when every field is within ~1.5 steps.
 */
export const CROP_MATCH_TOL = 0.008;

export function clampCrop(c) {
  const w = Math.max(MIN_CROP, Math.min(1, Number(c?.w) || 1));
  const h = Math.max(MIN_CROP, Math.min(1, Number(c?.h) || 1));
  return {
    x: Math.max(0, Math.min(1 - w, Number(c?.x) || 0)),
    y: Math.max(0, Math.min(1 - h, Number(c?.y) || 0)),
    w,
    h,
  };
}

/** Live scale bounds: total zoom stays within [1x, MAX_ZOOM] of the monitor. */
export function clampLiveScale(s, cropW) {
  const cw = Math.max(MIN_CROP, Math.min(1, Number(cropW) || 1));
  return Math.max(cw, Math.min(MAX_ZOOM * cw, Number(s) || 1));
}

/** Slider position (0 = top, 1 = bottom) -> absolute zoom 1x..MAX_ZOOM. */
export function sliderFractionToZoom(f) {
  const t = Math.max(0, Math.min(1, Number(f) || 0));
  return 1 + (1 - t) * (MAX_ZOOM - 1);
}

/** True when a frame's header crop shows the same region as `committed`. */
export function cropMatches(frameCrop, committed, tol = CROP_MATCH_TOL) {
  if (!frameCrop || !committed) return false;
  return (
    Math.abs(frameCrop.x - committed.x) <= tol &&
    Math.abs(frameCrop.y - committed.y) <= tol &&
    Math.abs(frameCrop.w - committed.w) <= tol &&
    Math.abs(frameCrop.h - committed.h) <= tol
  );
}

/**
 * One incremental pinch frame. Scales the live transform by d/dPrev and keeps
 * the content under the finger midpoint `anchor` (view-local px) fixed, then
 * clamps translation so the scaled content keeps covering the view.
 */
export function pinchStep({ live, dPrev, d, anchor, view, cropW }) {
  const vw = Math.max(1, view.w);
  const vh = Math.max(1, view.h);
  const ratio = Math.max(1, d) / Math.max(1, dPrev || d);
  const s = clampLiveScale(live.s * ratio, cropW);
  const cx = vw / 2;
  const cy = vh / 2;
  const sLive = Math.max(0.01, live.s);
  // Content point currently under the anchor (in un-transformed view space).
  const fbx = cx + (anchor.x - cx - live.tx) / sLive;
  const fby = cy + (anchor.y - cy - live.ty) / sLive;
  let tx = anchor.x - cx - (fbx - cx) * s;
  let ty = anchor.y - cy - (fby - cy) * s;
  const mx = Math.max(0, (vw * s - vw) / 2);
  const my = Math.max(0, (vh * s - vh) / 2);
  tx = Math.max(-mx, Math.min(mx, tx));
  ty = Math.max(-my, Math.min(my, ty));
  return { s, tx, ty };
}
