/**
 * Custom shortcuts (WIN > Pintasan). A shortcut = { id, name, mods[], key }.
 * mods are sent in the fixed order ctrl, shift, alt, win, then key, as one
 * msg.combo — names must match the agent's NAMED_KEYS (input.js).
 */
export const SC_MODS = ["ctrl", "shift", "alt", "win"];
export const SC_MOD_LABEL = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", win: "Win" };
export const MAX_SHORTCUTS = 48;

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");
export const SC_SYMBOLS = ["/", "\\", ".", ",", ";", "'", "-", "=", "[", "]", "`"];
export const SC_FKEYS = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
export const SC_NAMED = ["enter", "esc", "tab", "space", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown", "up", "down", "left", "right"];
const NAMED_LABEL = {
  enter: "Enter", esc: "Esc", tab: "Tab", space: "Spasi", backspace: "Backspace", delete: "Del", insert: "Ins",
  home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn", up: "↑", down: "↓", left: "←", right: "→",
};

/** Key picker pages: [title, keys]. */
export const SC_KEY_PAGES = [
  ["A–Z", LETTERS],
  ["0–9", DIGITS],
  ["Simbol", SC_SYMBOLS],
  ["F1–F12", SC_FKEYS],
  ["Lainnya", SC_NAMED],
];

const VALID_KEYS = new Set([...LETTERS, ...DIGITS, ...SC_SYMBOLS, ...SC_FKEYS, ...SC_NAMED]);

export function keyLabel(k) {
  if (!k) return "";
  if (NAMED_LABEL[k]) return NAMED_LABEL[k];
  if (/^f\d+$/.test(k)) return k.toUpperCase();
  return k.length === 1 ? k.toUpperCase() : k;
}

export function comboKeys(sc) {
  const mods = SC_MODS.filter((m) => sc?.mods?.includes(m));
  return sc?.key ? [...mods, sc.key] : mods;
}

export function comboLabel(sc) {
  return comboKeys(sc).map((k) => SC_MOD_LABEL[k] || keyLabel(k)).join("+");
}

export function cleanShortcut(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key || "").toLowerCase();
  if (!VALID_KEYS.has(key)) return null;
  const mods = SC_MODS.filter((m) => Array.isArray(raw.mods) && raw.mods.includes(m));
  const name = String(raw.name || "").trim().slice(0, 24);
  const id = String(raw.id || "").slice(0, 32) || `s${Math.random().toString(36).slice(2, 10)}`;
  return { id, name: name || comboLabel({ mods, key }), mods, key };
}

export function cleanShortcuts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const sc = cleanShortcut(raw);
    if (!sc || seen.has(sc.id)) continue;
    seen.add(sc.id);
    out.push(sc);
    if (out.length >= MAX_SHORTCUTS) break;
  }
  return out;
}

export function upsertShortcut(list, sc) {
  const clean = cleanShortcut(sc);
  if (!clean) return list;
  const i = list.findIndex((s) => s.id === clean.id);
  if (i >= 0) return list.map((s, j) => (j === i ? clean : s));
  return list.length >= MAX_SHORTCUTS ? list : [...list, clean];
}

export function removeShortcut(list, id) {
  return list.filter((s) => s.id !== id);
}

/** Move one step left (-1) or right (+1). */
export function moveShortcut(list, id, dir) {
  const i = list.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
