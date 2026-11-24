/**
 * Caret position for the phone's typing zoom (caret.js). A screen-pixel caret
 * rect becomes the same monitor-normalised frame as the cursor
 * (cursorOnMonitor): x/y = top-left, h = caret height, on = its centre lies
 * on the monitor (or the combined "all" rect) this phone is viewing.
 */
export function normCaret(rect, mon) {
  if (!rect || !mon) return { none: true };
  const w = Math.max(1, mon.w);
  const h = Math.max(1, mon.h);
  const cx = rect.x + (rect.w || 0) / 2;
  const cy = rect.y + rect.h / 2;
  return {
    x: (rect.x - mon.left) / w,
    y: (rect.y - mon.top) / h,
    h: rect.h / h,
    on: cx >= mon.left && cx < mon.left + w && cy >= mon.top && cy < mon.top + h,
  };
}

/** Dedupe key: sub-pixel jitter (3 decimals) does not count as a move. */
export function caretKey(msg) {
  if (!msg || msg.none) return "none";
  const r = (v) => Math.round(v * 1000);
  return `${r(msg.x)}:${r(msg.y)}:${r(msg.h)}:${msg.on ? 1 : 0}`;
}
