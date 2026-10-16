/**
 * Pure reconnect decisions (no React Native imports, testable in node).
 *
 * Two separate waits: the socket must OPEN within openTimeoutFor(link),
 * then the PC must answer auth within AUTH_TIMEOUT_MS. A socket that never
 * opens means "this address is unreachable" (phone left the home Wi-Fi,
 * PC asleep, tunnel restarted) — never "wrong code".
 */
export const AUTH_TIMEOUT_MS = 8000;
export const MAX_DELAY_MS = 15000;

/** LAN answers in milliseconds when reachable; a tunnel needs a TLS
 * handshake through Cloudflare, so it gets longer. */
export function openTimeoutFor(link) {
  if (link === "remote") return 10000;
  return 4000; // wifi / usb
}

/** Backoff: 1.5 s, 2.25 s, … capped at 15 s. */
export function backoffDelay(tries) {
  const n = Math.max(1, Number(tries) || 1);
  return Math.min(MAX_DELAY_MS, Math.round(1500 * Math.pow(1.5, Math.min(n - 1, 8))));
}

/** Search for the PC again (saved hosts → ntfy announce → LAN → tunnel)
 * instead of retrying the same URL? Yes when the address itself is dead
 * (socket never opened), and every 3rd try as a safety net. */
export function shouldRediscover({ tries, reason, hasCode }) {
  if (!hasCode) return false;
  if (reason === "unreachable" || reason === "open-failed") return true;
  return Number(tries) % 3 === 0;
}
