/**
 * Typing zoom that follows the PC caret ({t:"caret"} from the agent). The
 * user picks how big text should look on the phone (textPx); the zoom comes
 * from the caret height, so small and large PC text both land at that size.
 * Coordinates are monitor-normalised, like the cursor.
 */
import { MAX_ZOOM, camFor, monitorToView } from "./camera.js";

export const TEXT_PX_DEFAULT = 24;
export const TEXT_PX_MIN = 10;
export const TEXT_PX_MAX = 80;
export const REZOOM_RATIO = 0.25;
export const SAFE_MARGIN = 0.2;
export const CARET_MIN_PX = 4;
export const CARET_MAX_PX = 200;

/** Usable caret or null (none, or not on the monitor being viewed). */
export function caretTarget(msg, monPxH) {
  if (!msg || msg.none || msg.on === false) return null;
  if (![msg.x, msg.y, msg.h].every(Number.isFinite)) return null;
  const px = msg.h * (monPxH || 0);
  return { x: msg.x, y: msg.y, h: msg.h, validH: px >= CARET_MIN_PX && px <= CARET_MAX_PX };
}

export function zoomForText(textPx, h, fit) {
  const s = textPx / Math.max(1e-6, h * fit.bh);
  return Math.min(MAX_ZOOM, Math.max(1, s));
}

export function shouldRezoom(prevH, h) {
  if (!prevH) return true;
  return Math.abs(h - prevH) / prevH > REZOOM_RATIO;
}

/** New camera, or null when the zoom is unchanged and the caret sits inside
 * the middle of the view (so typing along a line keeps the picture still). */
export function followCam(cur, caret, s, fit, vw, vh) {
  const cy = caret.y + caret.h / 2;
  if (Math.abs(s - cur.s) < 1e-3) {
    const p = monitorToView(caret.x, cy, cur, fit, vw, vh);
    const inX = p.x >= vw * SAFE_MARGIN && p.x <= vw * (1 - SAFE_MARGIN);
    const inY = p.y >= vh * SAFE_MARGIN && p.y <= vh * (1 - SAFE_MARGIN);
    if (inX && inY) return null;
  }
  return camFor(s, caret.x, cy, fit, vw, vh);
}

/** Text size on the phone at zoom s (pinch -> saved textPx). */
export function textPxFromZoom(s, h, fit) {
  return s * h * fit.bh;
}
