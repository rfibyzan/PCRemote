// Pure helpers for the app launcher sheet (node-testable).
export const RECENT_MAX = 10;

const norm = (s) => String(s || "").toLowerCase();

// Search: name starts with q first, then a word starts with q, then contains q.
export function filterApps(list, q) {
  const s = norm(q).trim();
  if (!s) return list || [];
  const rank = (a) => {
    const n = norm(a.name);
    if (n.startsWith(s)) return 0;
    if (n.split(/[\s\-_.()]+/).some((w) => w.startsWith(s))) return 1;
    if (n.includes(s)) return 2;
    return -1;
  };
  return (list || [])
    .map((a) => [rank(a), a])
    .filter(([r]) => r >= 0)
    .sort((x, y) => x[0] - y[0] || x[1].name.localeCompare(y[1].name))
    .map(([, a]) => a);
}

// Opened from the phone -> front of the recent list (no duplicates).
export function pushRecent(recent, id, max = RECENT_MAX) {
  return [id, ...(recent || []).filter((x) => x !== id)].slice(0, max);
}

export function togglePin(pinned, id) {
  const p = pinned || [];
  return p.includes(id) ? p.filter((x) => x !== id) : [...p, id];
}

// The "Terakhir dibuka" row: pinned first, then recent, only apps still on the PC.
export function quickRow(list, recent, pinned, max = RECENT_MAX) {
  const byId = new Map((list || []).map((a) => [a.id, a]));
  const ids = [...(pinned || []), ...(recent || []).filter((x) => !(pinned || []).includes(x))];
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, Math.max(max, (pinned || []).length));
}
