/**
 * Layout "C" for PAD / TYPE / WIN (Rafi's pick, 2026-10-11).
 *
 * Every tab reserves the SAME fixed-height control area under the viewer
 * (CONTROL_H, at most two rows of buttons) and the viewer fills everything
 * else. Since header, tab bar and control area are identical on all three
 * portrait tabs, the viewer is the same size on every tab and as big as
 * possible for zoom/pinch. Extra buttons live behind a "⋯" page / section
 * tabs inside that area, stream settings live in a popover over the viewer.
 * Pure: no React Native imports, tested in tablayout.test.js.
 */
export const CONTROL_H = 128; // dp, the whole area under the viewer
export const CONTROL_GAP = 6;
export const CONTROL_PAD = 6; // bottom padding inside CONTROL_H
export const CONTROL_INNER = CONTROL_H - CONTROL_PAD; // height rows can use

/**
 * Split CONTROL_H into rows. `fixed` = heights of rows that keep their own
 * height (e.g. a 36 dp text field), `flexRows` = how many rows share the rest.
 * Returns the height of one flexible row (never below 28 dp).
 */
export function rowHeight(flexRows, fixed = [], total = CONTROL_INNER, gap = CONTROL_GAP) {
  const n = Math.max(1, Math.floor(Number(flexRows) || 1));
  const rows = n + fixed.length;
  const used = fixed.reduce((a, b) => a + (Number(b) || 0), 0) + gap * (rows - 1);
  return Math.max(28, Math.floor((total - used) / n));
}

/** Viewer height the layout leaves on a window (for previews/tests). */
export function viewerHeight(winH, chromeH) {
  return Math.max(0, Math.round((Number(winH) || 0) - (Number(chromeH) || 0) - CONTROL_H));
}
