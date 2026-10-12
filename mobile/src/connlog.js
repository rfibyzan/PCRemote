/** Connection log (pure, unit-tested): every discovery / connect step with a
 * timestamp, so a failed connect always says WHERE it stopped. Shown on the
 * connect screen and the Devices screen, and copyable as plain text. */
export function createConnLog(max = 200) {
  const items = [];
  const subs = new Set();
  let last = "";
  return {
    add(text, level = "info", now = Date.now()) {
      const t = String(text || "").trim();
      if (!t) return;
      // The same line twice in a row (status + progress echo) is noise.
      if (t === last && items[0] && now - items[0].ts < 1500) return;
      last = t;
      items.unshift({ ts: now, level, text: t });
      if (items.length > max) items.length = max;
      for (const fn of [...subs]) {
        try {
          fn(items);
        } catch {
          // a broken view must not break logging
        }
      }
    },
    list() {
      return items.slice();
    },
    clear() {
      items.length = 0;
      last = "";
      for (const fn of [...subs]) fn(items);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

export function clockOf(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Oldest first, one line each: what the user pastes into a bug report. */
export function formatLog(items, header = "") {
  const lines = items
    .slice()
    .reverse()
    .map((it) => `${clockOf(it.ts)} ${it.level === "error" ? "ERR " : it.level === "warn" ? "WARN" : it.level === "ok" ? "OK  " : "    "} ${it.text}`);
  return (header ? `${header}\n` : "") + lines.join("\n");
}
