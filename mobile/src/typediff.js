/**
 * Live typing helpers (TYPE "Ketik langsung"). The hidden input always holds
 * a short sentinel so Backspace on an "empty" field still reaches us; every
 * change is diffed against the previous value and turned into keys for the
 * PC. Pure: tested in typediff.test.js.
 */
// Two bases told apart by their first char. 8 long so a burst of Backspaces
// while the reset lags still has text to eat (an empty field sends nothing).
export const SENTINELS = ["\u00b7".repeat(8), "\u02d9".repeat(8)];

/** Diff prev -> next: { removed (backspaces), added (text) }. */
export function diffInput(prev, next) {
  const a = String(prev ?? "");
  const b = String(next ?? "");
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a[p] === b[p]) p += 1;
  return { removed: a.length - p, added: b.slice(p) };
}

/**
 * Robust live diff. The hidden input is reset to a sentinel after every
 * change, but when the JS thread lags (bad connection, busy decoder) the
 * keyboard keeps typing into the OLD text before the reset lands, and a
 * reset lands silently (no onChangeText). Diffing against the wrong base
 * either leaks sentinel dots to the PC (stray ' marks) or swallows keys.
 *
 * The two sentinels start with different chars, and each reset picks the
 * one whose first char differs from the text the field held. So the first
 * char of the new text tells which base it grew from: the sentinel we last
 * set (reset landed) or the last text the keyboard reported (not yet).
 * Sentinel characters never go to the PC.
 */
export function liveDiff(lastNative, next, sentinel = SENTINELS[0]) {
  const last = String(lastNative ?? "");
  const b = String(next ?? "");
  const landed = b.length > 0 && b[0] === sentinel[0] && last[0] !== sentinel[0];
  const d = diffInput(landed ? sentinel : last, b);
  return { removed: d.removed, added: d.added.replace(SENTINEL_RE, "") };
}

/** The sentinel to reset to after the field reported `native`. */
export function nextSentinel(native) {
  return String(native ?? "")[0] === SENTINELS[0][0] ? SENTINELS[1] : SENTINELS[0];
}
const SENTINEL_RE = /[\u00b7\u02d9]/g;

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
