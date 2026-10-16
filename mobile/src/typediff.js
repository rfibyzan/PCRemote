/**
 * Live typing helpers (TYPE "Ketik langsung"). The hidden input always holds
 * a short sentinel so Backspace on an "empty" field still reaches us; every
 * change is diffed against the previous value and turned into keys for the
 * PC. Pure: tested in typediff.test.js.
 */
export const SENTINELS = ["\u00b7\u00b7", "\u00b7\u02d9"]; // alternated so a reset always re-renders

/** Diff prev -> next: { removed (backspaces), added (text) }. */
export function diffInput(prev, next) {
  const a = String(prev ?? "");
  const b = String(next ?? "");
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a[p] === b[p]) p += 1;
  return { removed: a.length - p, added: b.slice(p) };
}

// Characters the agent's key map knows by name (input.js NAMED_KEYS), so a
// held Ctrl/Alt/Shift/Win + this char can go as a real chord.
const CHORD_RE = /^[a-z0-9\-=,./;'[\]\\`]$/i;

/** Key name for a chord with held modifiers, or null. */
export function chordKey(ch) {
  return typeof ch === "string" && CHORD_RE.test(ch) ? ch.toLowerCase() : null;
}

/** Last few typed characters for the status pill ("d u n i a"). */
export function pushRecent(recent, added, removed, max = 8) {
  let r = String(recent || "");
  if (removed > 0) r = r.slice(0, Math.max(0, r.length - removed));
  r = (r + String(added || "").replace(/\n/g, "\u21b5")).slice(-max);
  return r;
}
