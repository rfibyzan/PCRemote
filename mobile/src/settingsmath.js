/**
 * Pure sync plan (settingsync.js). Per key, newest timestamp wins:
 *  - PC newer (or phone never stamped it) -> apply the PC value
 *  - phone newer                          -> push the phone value
 *  - PC has nothing (full list only)      -> push, stamping unstamped local
 *    values with `now` so they win next time
 * push entries without `v` mean "read the current local value".
 */
export function planSync({ keys, remote = {}, localTs = {}, localValues = {}, full = false, now = Date.now() }) {
  const apply = {};
  const push = {};
  for (const k of keys) {
    const r = remote[k];
    const rts = r ? Number(r.ts) || 0 : 0;
    const lt = Number(localTs[k]) || 0;
    if (r && r.v !== undefined && rts > lt) {
      apply[k] = { v: r.v, ts: rts };
    } else if (r && lt > rts) {
      push[k] = { ts: lt };
    } else if (!r && full) {
      if (lt > 0) push[k] = { ts: lt };
      else if (localValues[k] != null) push[k] = { v: localValues[k], ts: now };
    }
  }
  return { apply, push };
}
