/**
 * Caret follow for phones in live typing ({t:"caretWatch", on}). While at
 * least one connection asks, the caret is read every 100 ms (Win32 first,
 * UI Automation at most every 250 ms when Win32 has nothing) and each asking
 * phone gets {t:"caret", x, y, h, on} / {t:"caret", none:true} in its own
 * view's frame (monitorFor), only when it changed.
 */
import { caretKey, normCaret } from "./caretmath.js";

const TICK_MS = 100;
const UIA_EVERY_MS = 250;

export function createCaretWatch({ send, monitorFor, readWin32, uia, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  const keys = new Map(); // ws -> last sent key (watchers only)
  let timer = null;
  let busy = false;
  let lastUiaAt = -Infinity;
  let uiaRect = null;

  function stopIfIdle() {
    if (keys.size || !timer) return;
    clearTimer(timer);
    timer = null;
    uiaRect = null;
    lastUiaAt = -Infinity;
    try {
      uia.stop();
    } catch {
      // best effort
    }
  }

  function set(ws, on) {
    if (on) {
      keys.set(ws, null); // null = send whatever is current on the next tick
      if (!timer) timer = setTimer(() => tick().catch(() => {}), TICK_MS);
    } else {
      keys.delete(ws);
      stopIfIdle();
    }
  }

  async function readRect() {
    let rect = null;
    try {
      rect = readWin32();
    } catch {
      rect = null;
    }
    if (rect) {
      uiaRect = null;
      return rect;
    }
    const t = now();
    if (t - lastUiaAt >= UIA_EVERY_MS) {
      lastUiaAt = t;
      let v;
      try {
        v = await uia.read();
      } catch {
        v = null;
      }
      // undefined = no answer in time (busy app): keep the last rect.
      if (v !== undefined) uiaRect = v;
    }
    return uiaRect;
  }

  async function tick() {
    if (busy || !keys.size) return;
    busy = true;
    try {
      const rect = await readRect();
      for (const ws of [...keys.keys()]) {
        let msg;
        try {
          msg = normCaret(rect, monitorFor(ws));
        } catch {
          msg = { none: true };
        }
        const key = caretKey(msg);
        if (keys.get(ws) === key) continue;
        keys.set(ws, key);
        send(ws, msg.none ? { t: "caret", none: true } : { t: "caret", x: msg.x, y: msg.y, h: msg.h, on: msg.on });
      }
    } finally {
      busy = false;
    }
  }

  return { set, drop: (ws) => set(ws, false), tick };
}
