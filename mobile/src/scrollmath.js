/** Pure scroll math (no RN imports, so `node src/scrollmath.test.js` runs).
 *
 * Windows wheel sign: +dy = content moves down (view goes UP the page),
 * +dx = view goes RIGHT. Touch: +dy = finger moved down.
 *
 * natural (phone-like, default): content follows the finger.
 *   finger up (dy < 0) -> view goes down the page -> wheel dy < 0.
 * inverse (mouse-wheel-like): finger up -> view goes up -> wheel dy > 0.
 */
export const SPEEDS = [0.5, 0.75, 1, 1.5, 2];
export const DEFAULT_SCROLL = { natural: true, speed: 2 }; // speed = index into SPEEDS
export const NOTCH = 120; // one Windows wheel notch

export function speedFactor(i) {
  const k = Math.max(0, Math.min(SPEEDS.length - 1, Math.round(Number(i))));
  return Number.isFinite(k) ? SPEEDS[k] : 1;
}

/** Normalize a stored/partial pref object. */
export function normScroll(p) {
  const o = p && typeof p === "object" ? p : {};
  const speed = Number.isFinite(Number(o.speed)) ? Math.max(0, Math.min(SPEEDS.length - 1, Math.round(Number(o.speed)))) : DEFAULT_SCROLL.speed;
  return { natural: o.natural === undefined ? DEFAULT_SCROLL.natural : !!o.natural, speed };
}

/** Finger delta (px) -> wheel delta. `gain` = wheel units per px at speed 1. */
export function wheelFromSwipe(dx, dy, pref, gain = 1) {
  const p = normScroll(pref);
  const k = gain * speedFactor(p.speed);
  const sign = p.natural ? 1 : -1;
  // natural: wheel = finger (up -> negative, right -> view left = negative)
  return { dx: Math.round(sign * dx * k), dy: Math.round(sign * dy * k) };
}

/** Accumulates wheel units and reports whole notches crossed (for haptics). */
export function makeNotchCounter() {
  let acc = 0;
  return {
    add(units) {
      acc += units;
      const n = acc > 0 ? Math.floor(acc / NOTCH) : Math.ceil(acc / NOTCH);
      acc -= n * NOTCH;
      return n;
    },
    reset() {
      acc = 0;
    },
  };
}

/** Fling: next velocity (px/ms) after one frame of `ms`, or 0 when done. */
export const FLING_MIN = 0.25; // px/ms needed to start a fling
export function flingStep(v, ms = 16, friction = 0.94) {
  const nv = v * Math.pow(friction, ms / 16);
  return Math.abs(nv) < 0.04 ? 0 : nv;
}

/** Thumb offset: follows the finger, clamped to the track (rubber-free). */
export function clampThumb(off, trackH, thumbH) {
  const lim = Math.max(0, (trackH - thumbH) / 2);
  return Math.max(-lim, Math.min(lim, off));
}
