/**
 * One viewer size for PAD / TYPE / WIN.
 *
 * The viewer used to be `flex: 1`, so it took whatever the tab's own controls
 * left over and changed size on every tab switch (and with the soft keyboard).
 * Now it is a fixed 16:9 box derived from the WINDOW only, which is identical
 * for all three (portrait-locked) tabs, so switching tabs never resizes it.
 * Pure: no React Native imports, tested in tablayout.test.js.
 */
export const VIEWER_MARGIN = 8;
export const VIEWER_ASPECT = 16 / 9;
export const VIEWER_MAX_FRAC = 0.4; // of window height
export const VIEWER_MIN_H = 160;

export function viewerBox(winW, winH) {
  const w = Math.max(0, Math.round(Number(winW) || 0) - VIEWER_MARGIN * 2);
  const ideal = Math.round(w / VIEWER_ASPECT);
  const cap = Math.round((Number(winH) || 0) * VIEWER_MAX_FRAC);
  const h = Math.max(VIEWER_MIN_H, Math.min(ideal, cap || ideal));
  return { width: w, height: h };
}
