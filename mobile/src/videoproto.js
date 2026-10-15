/**
 * Pure parts of the opt-in H.264 stream (no React / Expo imports, tested by
 * videoproto.test.js). Wire format: runtime/agent/src/videoenc.js.
 */

/** Binary "PV" message: 16-byte header + one Annex-B access unit, or null. */
export function parseVideoPacket(buf) {
  if (!buf || buf.byteLength < 17) return null;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x56) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    t: "video",
    mon: bytes[2] === 1 ? "all" : bytes[3],
    w: view.getUint16(4, true),
    h: view.getUint16(6, true),
    cx: view.getUint16(8, true) / 10000,
    cy: view.getUint16(10, true) / 10000,
    key: Boolean(bytes[12] & 1),
    config: Boolean(bytes[12] & 2),
    seq: view.getUint16(14, true),
    data: bytes.subarray(16),
  };
}

export function isVideoPacket(buf) {
  if (!buf || buf.byteLength < 2) return false;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf, 0, 2);
  return bytes[0] === 0x50 && bytes[1] === 0x56;
}

// Quality presets (controls.js q keys) -> H.264 settings.
// Low = lite, Mid = low/med, High = high/super.
const VIDEO_PRESET = {
  lite: { kbps: 1500, fps: 20, width: 1280 },
  low: { kbps: 4000, fps: 30, width: 1600 },
  med: { kbps: 4000, fps: 30, width: 1600 },
  high: { kbps: 8000, fps: 30, width: 1600 },
  super: { kbps: 8000, fps: 30, width: 1600 },
};
// Tunnel (internet) links rarely sustain more than this.
export const REMOTE_KBPS_CAP = 2500;

/** {q, qStep, fpsStep} + link -> {fps, kbps, width} for {t:"video"}.
 * Q +/- moves bitrate by 25 % per step, fps +/- by 3 per step. */
export function videoParams({ q = "low", qStep = 0, fpsStep = 0 } = {}, link = "") {
  const base = VIDEO_PRESET[q] || VIDEO_PRESET.low;
  const qs = Math.max(-5, Math.min(8, Math.round(Number(qStep) || 0)));
  const fs = Math.max(-5, Math.min(10, Math.round(Number(fpsStep) || 0)));
  let kbps = Math.round(base.kbps * Math.max(0.25, 1 + qs * 0.25));
  kbps = Math.max(500, Math.min(20000, kbps));
  if (String(link).toLowerCase() === "remote") kbps = Math.min(kbps, REMOTE_KBPS_CAP);
  const fps = Math.max(10, Math.min(60, base.fps + fs * 3));
  return { fps, kbps, width: base.width };
}

export function fmtKbps(kbps) {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps % 1000 ? 1 : 0)} Mbps` : `${kbps} kbps`;
}
