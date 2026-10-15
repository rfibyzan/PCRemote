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

// ---- Shared quality "level" -------------------------------------------------
// ONE stored state {q, qStep, fpsStep} (SecureStore pcremote.quality) drives
// both codecs: the preset q plus the two step counters is the level, and each
// codec turns it into its own numbers. A custom setting therefore converts
// automatically when the stream switches between H.264 and JPEG.
//
// Mapping per step (same sign = same direction in both codecs):
//   qStep   +1: JPEG Q +8 (18..92)      H.264 bitrate +25 % of preset (500..20000 kbps)
//   fpsStep +1: JPEG fps +2 (1..30)     H.264 fps +5 (10..60)
// Each codec clamps on its own, so one codec can sit in a dead zone where the
// other still moves (e.g. Low at qStep -2 is Q18 in JPEG but 1 Mbps in H.264);
// stepLevel() jumps over such dead zones so a press always changes what is shown.

export const Q_STEP_MIN = -5;
export const Q_STEP_MAX = 8;
export const FPS_STEP_MIN = -5;
export const FPS_STEP_MAX = 10;

export function clampQStep(v) {
  return Math.max(Q_STEP_MIN, Math.min(Q_STEP_MAX, Math.round(Number(v) || 0)));
}
export function clampFpsStep(v) {
  return Math.max(FPS_STEP_MIN, Math.min(FPS_STEP_MAX, Math.round(Number(v) || 0)));
}

// JPEG (existing agent backend): Low = lite (Q18/6fps), Mid = low (Q26/13fps), High = high (Q40/22fps).
export const BASE_Q = { lite: 18, low: 26, med: 26, high: 40, super: 40 };
export const BASE_FPS = { lite: 6, low: 13, med: 13, high: 22, super: 22 };

export function qValue(q, qStep) {
  return Math.max(18, Math.min(92, Math.round((BASE_Q[q] ?? 26) + clampQStep(qStep) * 8)));
}
export function fpsValue(q, fpsStep) {
  return Math.max(1, Math.min(30, Math.round((BASE_FPS[q] ?? 13) + clampFpsStep(fpsStep) * 2)));
}

// H.264: Low = lite, Mid = low/med, High = high/super.
export const VIDEO_PRESET = {
  lite: { kbps: 2000, fps: 30 },
  low: { kbps: 5000, fps: 30 },
  med: { kbps: 5000, fps: 30 },
  high: { kbps: 10000, fps: 60 },
  super: { kbps: 10000, fps: 60 },
};
// Tunnel (internet) links rarely sustain more than this.
export const REMOTE_KBPS_CAP = 2500;
// Resolution follows bitrate: below this send 1280 wide (720p), else 1920 (1080p).
// The agent never upscales past the monitor/crop and keeps the size even.
export const HD_KBPS = 3000;

/** Uncapped H.264 bitrate for a level: preset base +/- 25 % per qStep. */
export function videoKbps(q, qStep) {
  const base = (VIDEO_PRESET[q] || VIDEO_PRESET.low).kbps;
  const kbps = Math.round(base * Math.max(0.25, 1 + clampQStep(qStep) * 0.25));
  return Math.max(500, Math.min(20000, kbps));
}
/** H.264 fps for a level: preset fps +/- 5 per fpsStep, 10..60. */
export function videoFps(q, fpsStep) {
  const base = (VIDEO_PRESET[q] || VIDEO_PRESET.low).fps;
  return Math.max(10, Math.min(60, base + clampFpsStep(fpsStep) * 5));
}
export function videoWidth(kbps) {
  return kbps < HD_KBPS ? 1280 : 1920;
}
export function isRemote(link) {
  return String(link || "").toLowerCase() === "remote";
}

/** {q, qStep, fpsStep} + link -> {fps, kbps, width} for {t:"video"}. */
export function videoParams({ q = "low", qStep = 0, fpsStep = 0 } = {}, link = "") {
  let kbps = videoKbps(q, qStep);
  if (isRemote(link)) kbps = Math.min(kbps, REMOTE_KBPS_CAP);
  return { fps: videoFps(q, fpsStep), kbps, width: videoWidth(kbps) };
}

/** Next step from `cur` in direction d (+1/-1) whose shown value differs, or
 * null at the limit (button disabled). Skips dead zones of the active codec. */
export function stepLevel(cur, d, valueAt, lo, hi) {
  const v0 = valueAt(cur);
  for (let n = cur + d; n >= lo && n <= hi; n += d) {
    if (valueAt(n) !== v0) return n;
  }
  return null;
}

/** What the quality steppers show for the active codec.
 * video = H.264 confirmed flowing; otherwise JPEG (incl. fallback). */
export function qualityView({ q = "low", qStep = 0, fpsStep = 0 } = {}, { video = false, link = "" } = {}) {
  const qs = clampQStep(qStep);
  const fs = clampFpsStep(fpsStep);
  if (video) {
    const kbpsAt = (n) => videoParams({ q, qStep: n }, link).kbps;
    const kbps = kbpsAt(qs);
    const capped = isRemote(link) && videoKbps(q, qs) > REMOTE_KBPS_CAP;
    const fps = videoFps(q, fs);
    return {
      video: true,
      qText: fmtKbps(kbps),
      qCaption: capped ? "Batas internet" : `Bitrate ${videoWidth(kbps) >= 1920 ? "1080p" : "720p"}`,
      fpsText: `${fps} fps`,
      qDown: stepLevel(qs, -1, kbpsAt, Q_STEP_MIN, Q_STEP_MAX),
      qUp: stepLevel(qs, 1, kbpsAt, Q_STEP_MIN, Q_STEP_MAX),
      fpsDown: stepLevel(fs, -1, (n) => videoFps(q, n), FPS_STEP_MIN, FPS_STEP_MAX),
      fpsUp: stepLevel(fs, 1, (n) => videoFps(q, n), FPS_STEP_MIN, FPS_STEP_MAX),
    };
  }
  return {
    video: false,
    qText: `Q${qValue(q, qs)}`,
    qCaption: "",
    fpsText: `${fpsValue(q, fs)} fps`,
    qDown: stepLevel(qs, -1, (n) => qValue(q, n), Q_STEP_MIN, Q_STEP_MAX),
    qUp: stepLevel(qs, 1, (n) => qValue(q, n), Q_STEP_MIN, Q_STEP_MAX),
    fpsDown: stepLevel(fs, -1, (n) => fpsValue(q, n), FPS_STEP_MIN, FPS_STEP_MAX),
    fpsUp: stepLevel(fs, 1, (n) => fpsValue(q, n), FPS_STEP_MIN, FPS_STEP_MAX),
  };
}

export function fmtKbps(kbps) {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps % 1000 ? 1 : 0)} Mbps` : `${kbps} kbps`;
}
