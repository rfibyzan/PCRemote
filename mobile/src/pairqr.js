/** Pair QR payload shown on the PC dashboard:
 *   pcremote://pair?c=<CODE>&h=<ip:port>,<ip:port>
 * The code is the lock code; hosts are optional LAN shortcuts (discovery
 * still runs when none of them answers). Pure, so it is unit-tested.
 */
// Same rule as protocol.normalizeCode (kept local so this file stays pure).
function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function parsePairQr(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let query = "";
  const m = text.match(/^pcremote:\/\/pair\/?\?(.*)$/i);
  if (m) {
    query = m[1];
  } else {
    // A bare code (someone made their own QR with just "ABCD 2345").
    const bare = normalizeCode(text);
    return bare.length === 8 && /^[A-Z0-9 -]+$/i.test(text) ? { code: bare, hosts: [] } : null;
  }
  const params = {};
  for (const part of query.split("&")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    let v = part.slice(i + 1);
    try {
      v = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      // keep the raw value
    }
    params[part.slice(0, i).toLowerCase()] = v;
  }
  return fromParams(params);
}

/** Same payload from router params ({ c, h }) after a deep link. */
export function fromParams(params) {
  const code = normalizeCode(params?.c);
  if (code.length !== 8) return null;
  const hosts = String(params?.h || "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => /^[\w.-]+:\d{2,5}$/.test(h))
    .slice(0, 6)
    .map((h) => {
      const i = h.lastIndexOf(":");
      return { host: h.slice(0, i), port: Number(h.slice(i + 1)) };
    });
  return { code, hosts };
}

/** "abcd2345" / "ABCD 2345" -> "ABCD 2345" (what the field shows). */
export function formatCodeInput(text) {
  const c = normalizeCode(text).slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)} ${c.slice(4)}` : c;
}
