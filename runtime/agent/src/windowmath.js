/**
 * Single-window stream (idea from Sill), pure parts. The phone streams the
 * window's monitor as usual and zooms its camera onto the window rect, so the
 * agent only has to say where each window is, normalized to its monitor.
 */

/** Monitor that holds the window's centre (else the most overlapped one). */
export function monitorOfRect(r, monitors) {
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  const hit = monitors.find((m) => cx >= m.left && cx < m.right && cy >= m.top && cy < m.bottom);
  if (hit) return hit;
  let best = null;
  let area = 0;
  for (const m of monitors) {
    const w = Math.min(r.right, m.right) - Math.max(r.left, m.left);
    const h = Math.min(r.bottom, m.bottom) - Math.max(r.top, m.top);
    if (w > 0 && h > 0 && w * h > area) {
      area = w * h;
      best = m;
    }
  }
  return best;
}

/** Window rect (screen px) -> {mon, x, y, w, h} normalized + clipped to its monitor, or null. */
export function placeWindow(r, monitors) {
  const mon = monitorOfRect(r, monitors);
  if (!mon) return null;
  const mw = Math.max(1, mon.right - mon.left);
  const mh = Math.max(1, mon.bottom - mon.top);
  const x0 = Math.max(0, Math.min(1, (r.left - mon.left) / mw));
  const y0 = Math.max(0, Math.min(1, (r.top - mon.top) / mh));
  const x1 = Math.max(0, Math.min(1, (r.right - mon.left) / mw));
  const y1 = Math.max(0, Math.min(1, (r.bottom - mon.top) / mh));
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  const q = (v) => Math.round(v * 10000) / 10000;
  return { mon: mon.id, x: q(x0), y: q(y0), w: q(x1 - x0), h: q(y1 - y0) };
}

/** Which windows are worth listing: visible, titled, not a tool window, not cloaked. */
export function listable({ visible, title, toolWindow, cloaked, w, h }) {
  return Boolean(visible && !cloaked && !toolWindow && String(title || "").trim() && w > 40 && h > 40);
}

/** "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -> "chrome". */
export function exeName(path) {
  const base = String(path || "").split(/[\\/]/).pop() || "";
  return base.replace(/\.exe$/i, "");
}

export const WINDOW_ACTIONS = new Set(["focus", "min", "close"]);
