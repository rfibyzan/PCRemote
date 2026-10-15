/**
 * PC Remote wire protocol (reconstructed from original v6 APK behavior +
 * runtime/agent source). Single source of truth for message builders,
 * binary frame parsing, and pairing crypto. PAD/Q/TYPE/WEBCAM/WIN/GAME
 * all share this module; GAME adds only gamepad messages.
 */
import * as Crypto from "expo-crypto";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

export const DEFAULT_PORT = 18765;
export const NTFY_HOSTS = ["https://ntfy.sh", "https://ntfy.adminforge.de", "https://ntfy.envs.net"];
export const NTFY_PREFIX = "pcremote";
export const STORE_LOCK = "pcremote.lock";
export const STORE_QUALITY = "pcremote.quality";
export const STORE_HOSTS = "pcremote.hosts";
export const STORE_SCROLL = "pcremote.scroll";

// Final bottom navigation: PAD | TYPE | GAME | WIN.
// Q and Webcam tabs were removed; their functionality lives on via
// StreamControls (quality/FPS) and the Cam monitor source.
export const MODES = ["Pad", "Type", "Game", "Win"];
// PAD sub-modes from the original hint strings.
export const PAD_SUBMODES = ["Look", "Click"];

// NOTE: GAME uses the same shared quality backend via msg.quality
// (StreamControls). No second quality system exists.

// XUSB button bits (must match runtime/agent/src/gamepad.js).
export const GAMEPAD_BUTTONS = {
  up: 0x0001, down: 0x0002, left: 0x0004, right: 0x0008,
  start: 0x0010, back: 0x0020, l3: 0x0040, r3: 0x0080,
  lb: 0x0100, rb: 0x0200, guide: 0x0400,
  a: 0x1000, b: 0x2000, x: 0x4000, y: 0x8000,
};

export function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sha256hex(text) {
  // expo-crypto digestStringAsync is async; pairing uses a sync SHA-256.
  // Minimal sync implementation via nacl? TweetNaCl has no SHA-256.
  // Use the well-known compact JS SHA-256 below (public domain style).
  return sha256Ascii(text);
}

// Compact sync SHA-256 (ASCII input) for room/key derivation.
function sha256Ascii(ascii) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bytes = [];
  for (let i = 0; i < ascii.length; i += 1) bytes.push(ascii.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let c = 0; c < bytes.length; c += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = (bytes[c + i * 4] << 24) | (bytes[c + i * 4 + 1] << 16) | (bytes[c + i * 4 + 2] << 8) | bytes[c + i * 4 + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, cc = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & cc) ^ (b & cc);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + cc) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

export function roomIdForCode(code) {
  return sha256hex(`pcremote-room:${normalizeCode(code)}`).slice(0, 20);
}

export function keyForCode(code) {
  const hex = sha256hex(`pcremote-v1:${normalizeCode(code)}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decrypt an ntfy announce payload (`nonceB64.boxB64`) with the lock key. */
export function decryptAnnounce(payload, key) {
  try {
    const [nonceB64, boxB64] = String(payload).split(".");
    const opened = nacl.secretbox.open(naclUtil.decodeBase64(boxB64), naclUtil.decodeBase64(nonceB64), key);
    if (!opened) return null;
    return JSON.parse(naclUtil.encodeUTF8(opened));
  } catch {
    return null;
  }
}

/**
 * Parse one binary WebSocket screen frame ("PR", 16-byte header + JPEG).
 * Returns null for invalid data — callers KEEP the last valid frame.
 */
export function parseBinaryFrame(buf) {
  if (!buf || buf.byteLength < 4) return null;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes[0] === 0x50 && bytes[1] === 0x52 && bytes.length >= 16) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = bytes[2];
    const mon = kind === 1 ? "all" : kind === 2 ? "cam" : bytes[3];
    return {
      t: "frame",
      mon,
      w: view.getUint16(4, true),
      h: view.getUint16(6, true),
      cx: view.getUint16(8, true) / 10000,
      cy: view.getUint16(10, true) / 10000,
      crop: { x: bytes[12] / 255, y: bytes[13] / 255, w: bytes[14] / 255, h: bytes[15] / 255 },
      jpeg: bytes.subarray(16),
    };
  }
  return null;
}

/** Chunked bytes -> base64 (Hermes-safe, no Buffer). */
export function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---- Message builders (names/shapes match runtime/agent/src/index.js) ----
export const msg = {
  // device = { id, name, model, os, app } so the PC dashboard can list and
  // disconnect this phone. Old agents ignore the extra field.
  auth: (token, device) => (device ? { t: "auth", token, device } : { t: "auth", token }),
  screen: (on) => ({ t: "screen", on: Boolean(on) }),
  move: (dx, dy) => ({ t: "move", dx, dy }),
  click: (btn, down = true, up = true) => ({ t: "click", btn, down, up }),
  scroll: (dx, dy) => ({ t: "scroll", dx, dy }),
  abs: (x, y, click) => (click ? { t: "abs", x, y, click } : { t: "abs", x, y }),
  drag: (phase, x, y, btn = "left") => ({ t: "drag", phase, x, y, btn }),
  key: (key, down, up) => {
    const m = { t: "key", key };
    if (down !== undefined) m.down = down;
    if (up !== undefined) m.up = up;
    return m;
  },
  combo: (keys, hold, release) => {
    const m = { t: "combo", keys };
    if (hold) m.hold = true;
    if (release) m.release = true;
    return m;
  },
  text: (s) => ({ t: "text", s }),
  media: (a) => ({ t: "media", a }),
  lock: () => ({ t: "lock" }),
  open: (target) => ({ t: "open", target }),
  monitor: (id) => ({ t: "monitor", id }),
  windows: () => ({ t: "windows" }),
  winAct: (id, a) => ({ t: "winAct", id, a }),
  quality: (q) => ({ t: "quality", ...q }),
  crop: (x, y, w, h) => ({ t: "crop", x, y, w, h }),
  cam: (on) => ({ t: "cam", on: Boolean(on) }),
  ping: () => ({ t: "ping" }),
  clipboard: (s) => (s != null ? { t: "clipboard", s } : { t: "clipboard" }),
  gamepad: (state) => ({ t: "gamepad", state }),
  gamepadEnd: () => ({ t: "gamepadEnd" }),
  // Opt-in H.264 stream (beta): p = {fps, kbps, width}. Old agents ignore it.
  video: (on, p) => (on ? { t: "video", on: true, ...(p || {}) } : { t: "video", on: false }),
};

// Re-exported so bundlers keep a single copy of the crypto helpers.
export { Crypto };
