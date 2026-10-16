/**
 * Phone settings kept on the PC (shortcuts, gamepad layout, quality, ...), so
 * they come back after the app is reinstalled. One JSON file next to lock.json:
 *   { v: 1, items: { <key>: { v: <value>, ts: <ms> } } }
 * Newest timestamp wins per key. Pairing data never comes here (the phone keeps
 * it: it is needed before it can talk to the agent at all).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockPath } from "./lock.js";

export const SETTING_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/;
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024;
export const MAX_KEYS = 64;

export function settingsPath() {
  if (process.env.PCREMOTE_SETTINGS) return process.env.PCREMOTE_SETTINGS;
  return join(dirname(lockPath()), "settings.json");
}

/** Pure merge: returns { items, changed } without touching disk. */
export function mergeSettings(items, set) {
  const next = { ...(items || {}) };
  const changed = {};
  if (!set || typeof set !== "object") return { items: next, changed };
  for (const [key, entry] of Object.entries(set)) {
    if (!SETTING_KEY_RE.test(key)) continue;
    if (!entry || typeof entry !== "object") continue;
    const ts = Number(entry.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (entry.v === undefined) continue;
    let size;
    try {
      size = JSON.stringify(entry.v).length;
    } catch {
      continue;
    }
    if (size > MAX_VALUE_BYTES) continue;
    const cur = next[key];
    if (cur && Number(cur.ts) >= ts) continue;
    if (!cur && Object.keys(next).length >= MAX_KEYS) continue;
    next[key] = { v: entry.v, ts };
    changed[key] = next[key];
  }
  if (JSON.stringify(next).length > MAX_TOTAL_BYTES) return { items: { ...(items || {}) }, changed: {} };
  return { items: next, changed };
}

export function createSettingsStore(file = settingsPath()) {
  let items = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw.items === "object" && raw.items) items = raw.items;
  } catch {
    // first run or unreadable: start empty
  }

  function persist() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, items }, null, 1)}\n`);
      renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  return {
    all: () => items,
    apply(set) {
      const res = mergeSettings(items, set);
      if (Object.keys(res.changed).length) {
        items = res.items;
        persist();
      }
      return res.changed;
    },
    file,
  };
}
