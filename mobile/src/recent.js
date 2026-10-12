/** Recent PCs this phone paired with (pure list logic, unit-tested).
 * Entry: { code, name, hosts: ["http://ip:port"], lastAt, link }.
 * Keyed by pair code: a PC that made a new code is a new entry. */
export const MAX_RECENT = 8;

export function upsertRecent(list, entry, now = Date.now()) {
  if (!entry?.code) return Array.isArray(list) ? list : [];
  const prev = (list || []).find((r) => r.code === entry.code) || {};
  const next = {
    code: entry.code,
    name: String(entry.name || prev.name || "PC").slice(0, 40),
    hosts: Array.isArray(entry.hosts) && entry.hosts.length ? entry.hosts.slice(0, 6) : prev.hosts || [],
    link: entry.link || prev.link || "",
    lastAt: entry.lastAt || now,
  };
  return [next, ...(list || []).filter((r) => r.code !== entry.code)].slice(0, MAX_RECENT);
}

export function removeRecent(list, code) {
  return (list || []).filter((r) => r.code !== code);
}

export function parseRecent(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((r) => r && typeof r.code === "string" && r.code.length >= 8) : [];
  } catch {
    return [];
  }
}

/** Newest announce wins: old ones in the 10 min window can carry a dead
 * tunnel URL (cloudflared makes a new one on every restart). */
export function newestAnnounce(bodies) {
  let best = null;
  for (const b of bodies || []) {
    if (!b || typeof b !== "object") continue;
    if (!best || (Number(b.ts) || 0) > (Number(best.ts) || 0)) best = b;
  }
  return best;
}

/** "3 menit lalu" style age for lists. */
export function agoText(ts, now = Date.now()) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "baru saja";
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}
