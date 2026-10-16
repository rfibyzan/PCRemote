/** Pure motion numbers (shared by motion.js worklets and tests). */
export const MOTION = {
  openMs: 260, // spring duration when a panel opens
  damping: 0.82, // ~ Sill's bounce 0.15-0.2
  closeMs: 180, // ease-out fade when it closes
  popFrom: 0.94, // panels grow from 94% at their origin
  touchFrom: 0.6, // menus opened from a held item grow from 60% at that item
  sheetRise: 0.35, // sheets rise from 35% of the screen height below
  pressScale: 0.96,
  pulseMs: 700, // one half-cycle of a breathing pulse
  listStagger: 40, // ms between rows of a short list (Recent PC)
  stagger: 15, // ms per row for grids that appear
  staggerMax: 240,
};

/** Frame of a panel at progress v (0 closed, 1 open; a spring may overshoot). */
export function panelFrame(kind, v, height, dx = 0, dy = 0) {
  "worklet";
  const o = v < 0 ? 0 : v > 1 ? 1 : v;
  if (kind === "sheet") return { opacity: o, x: 0, y: (1 - v) * height * MOTION.sheetRise, scale: 1 };
  if (kind === "pop") return { opacity: o, x: 0, y: 0, scale: MOTION.popFrom + (1 - MOTION.popFrom) * v };
  if (kind === "touch") return { opacity: o, x: dx * (1 - v), y: dy * (1 - v), scale: MOTION.touchFrom + (1 - MOTION.touchFrom) * v };
  return { opacity: o, x: 0, y: 0, scale: 1 };
}

/** Delay before row `index` of a grid fades in. */
export function staggerDelay(index, cols) {
  const row = Math.floor(index / Math.max(1, cols));
  return Math.min(MOTION.staggerMax, row * MOTION.stagger * Math.max(1, cols) / 2);
}
