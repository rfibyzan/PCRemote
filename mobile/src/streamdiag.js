/**
 * Why displayed fps is below the target, from the PC's own counters
 * ({t:"streamStats"}) and the phone's receive/display meters. Pure, tested.
 * Order matters: a static screen explains everything else away.
 */
export function diagnoseStream({ target, shown, recv, pc }) {
  const t = Math.max(1, Number(target) || 1);
  if (shown >= t * 0.8) return "";
  if (pc) {
    if (pc.same >= Math.max(1, t * 0.3) && pc.sent < t * 0.8) return "layar statis";
    if (pc.busy >= 1) return "jaringan lambat";
    if (pc.capMs > 900 / t) return `PC lambat ${pc.capMs}ms`;
  }
  if (recv - shown >= 3) return "HP lambat decode";
  return "";
}

/**
 * Slow-link banner (idea from Sill): the PC reports frames held back by a
 * full socket (streamStats.busy). One bad sample can be a hiccup, so the
 * banner shows after LAG_SAMPLES samples in a row (~2 s each) and hides again
 * after the same number of good ones. Returns the next {bad, good, on}.
 */
export const LAG_SAMPLES = 2;
export function lagStep(prev, pc) {
  const p = prev || { bad: 0, good: 0, on: false };
  if (!pc) return { bad: 0, good: 0, on: false };
  const busy = Number(pc.busy) >= 1;
  const bad = busy ? p.bad + 1 : 0;
  const good = busy ? 0 : p.good + 1;
  let on = p.on;
  if (!on && bad >= LAG_SAMPLES) on = true;
  if (on && good >= LAG_SAMPLES) on = false;
  return { bad, good, on };
}

/** One notch lighter: High -> Mid -> Low, then Low with fewer fps/lower Q.
 * Returns null when already at the floor. q/qStep/fpsStep as in controls.js. */
export function lighterQuality({ q, qStep = 0, fpsStep = 0 }) {
  if (qStep > 0 || fpsStep > 0) return { q, qStep: Math.min(0, qStep), fpsStep: Math.min(0, fpsStep) };
  if (q === "high" || q === "super") return { q: "low", qStep: 0, fpsStep: 0 };
  if (q === "low" || q === "med") return { q: "lite", qStep: 0, fpsStep: 0 };
  if (fpsStep > -5 || qStep > -5) return { q: "lite", qStep: Math.max(-5, qStep - 1), fpsStep: Math.max(-5, fpsStep - 2) };
  return null;
}
