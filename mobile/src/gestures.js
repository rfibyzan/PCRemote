/**
 * Multi-finger touchpad swipes, Windows precision-touchpad style (idea from
 * Sill's Mac trackpad gestures). Pure, tested in gestures.test.js.
 *
 *   3 fingers  up    -> Task View (Win+Tab)
 *              down  -> Show desktop (Win+D)
 *              left  -> previous app (Alt+Shift+Tab)
 *              right -> next app (Alt+Tab)
 *   4 fingers  left/right -> previous / next virtual desktop (Ctrl+Win+Left/Right)
 *              up/down    -> same as 3 fingers
 */
export const SWIPE_MIN = 60; // dp the finger centroid must travel

const THREE = {
  up: { keys: ["win", "tab"], label: "Task View" },
  down: { keys: ["win", "d"], label: "Desktop" },
  left: { keys: ["alt", "shift", "tab"], label: "Aplikasi sebelumnya" },
  right: { keys: ["alt", "tab"], label: "Aplikasi berikutnya" },
};
const FOUR = {
  ...THREE,
  left: { keys: ["ctrl", "win", "left"], label: "Desktop sebelumnya" },
  right: { keys: ["ctrl", "win", "right"], label: "Desktop berikutnya" },
};

/** Average point of a touch list ({pageX, pageY}). */
export function centroid(touches) {
  const list = Array.from(touches || []);
  if (!list.length) return null;
  let x = 0;
  let y = 0;
  for (const t of list) {
    x += Number(t.pageX) || 0;
    y += Number(t.pageY) || 0;
  }
  return { x: x / list.length, y: y / list.length };
}

/** Direction of a swipe, or "" while it is still too short / too diagonal. */
export function swipeDir(dx, dy, min = SWIPE_MIN) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < min) return "";
  if (ax > ay * 1.3) return dx > 0 ? "right" : "left";
  if (ay > ax * 1.3) return dy > 0 ? "down" : "up";
  return "";
}

/** {keys, label} for a finger count + direction, or null. */
export function gestureFor(fingers, dir) {
  if (!dir || fingers < 3) return null;
  return (fingers >= 4 ? FOUR : THREE)[dir] || null;
}
