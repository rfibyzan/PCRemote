/**
 * Latency (round trip phone -> PC -> phone) for the "● Lancar · 23 ms" pill.
 * The phone sends {t:"ping", c: sentAt}; the agent echoes c in its pong
 * (older agents don't, then the oldest unanswered ping is used: one socket,
 * so pongs come back in order). The ping rides the same socket as the
 * stream, so the number includes waiting behind video frames: it is the lag
 * a click really feels. Pure: tested in latency.test.js.
 */

export const RTT_PROBE_MS = 2000;
const RTT_MAX_MS = 30000; // older than this = a stale ping, ignore

/** Round trip of one pong, or null. `queue` = send times of unanswered
 * pings (oldest first); it is consumed in place. */
export function rttFromPong(queue, pong, now) {
  const sent = queue.length ? queue.shift() : null;
  const c = Number(pong?.c);
  const at = Number.isFinite(c) && c > 0 ? c : sent;
  if (!Number.isFinite(at)) return null;
  const ms = now - at;
  return ms >= 0 && ms <= RTT_MAX_MS ? ms : null;
}

/** Smoothed latency: quick to show a spike, but one odd sample can't jump
 * the number around. */
export function smoothRtt(prev, sample) {
  if (sample == null || !(sample >= 0)) return prev;
  if (prev == null) return Math.round(sample);
  const w = sample > prev ? 0.5 : 0.25; // rise faster than fall
  return Math.round(prev + (sample - prev) * w);
}

/** good < 80 ms (feels instant), ok < 200 ms, slow above. */
export function latencyLevel(ms) {
  if (ms == null) return null;
  if (ms < 80) return "good";
  if (ms < 200) return "ok";
  return "slow";
}
