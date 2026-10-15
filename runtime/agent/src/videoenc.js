/**
 * Pure helpers for the opt-in H.264 screen stream (src/video.js).
 * No Windows / koffi / child_process here so `node src/video_test.js` runs
 * anywhere.
 *
 * Pipeline: ffmpeg gdigrab -> H.264 encoder -> FLV on stdout. FLV is used
 * only as framing: every tag carries exactly one access unit with its length
 * up front, so the agent knows where an AU ends the moment its last byte
 * arrives (no "wait for the next start code" frame of latency, no guessing on
 * pipe chunk boundaries). The demuxer turns each AVC tag back into Annex-B
 * (start codes) and prepends SPS/PPS to every keyframe, so what goes on the
 * wire is plain Annex-B access units a phone decoder can join at any IDR.
 */

export const VIDEO_MAGIC = [0x50, 0x56]; // "PV"
export const VIDEO_HEADER_BYTES = 16;
export const FLAG_KEY = 0x01;
export const FLAG_CONFIG = 0x02; // AU starts with SPS/PPS

const START = Buffer.from([0, 0, 0, 1]);

/** Encoders tried in order. Each entry is one complete argument variant;
 * the first one that survives a short probe is used for the session. */
export const ENCODER_CANDIDATES = ["h264_nvenc", "h264_nvenc_legacy", "h264_qsv", "h264_amf", "libx264"];

export function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Normalize a phone {t:"video"} request into encoder settings. */
export function videoRequest(msg = {}) {
  return {
    fps: clampInt(msg.fps, 5, 60, 30),
    kbps: clampInt(msg.kbps, 300, 20000, 4000),
    maxWidth: clampInt(msg.width, 480, 1920, 1600),
  };
}

/** Even output size, aspect kept, never upscaled, width <= maxWidth. */
export function outputSize(srcW, srcH, maxWidth = 1600) {
  const sw = Math.max(2, Math.round(Number(srcW) || 0));
  const sh = Math.max(2, Math.round(Number(srcH) || 0));
  let w = Math.min(sw, Math.max(160, Math.round(Number(maxWidth) || 1600)));
  let h = Math.round((sh * w) / sw);
  // Keep the long side sane for phone decoders (most cap at 1920x1088 level 4.x).
  if (h > 1600) {
    h = 1600;
    w = Math.round((sw * h) / sh);
  }
  w -= w % 2;
  h -= h % 2;
  return { w: Math.max(2, w), h: Math.max(2, h) };
}

/** Even capture rect inside the given monitor rect (gdigrab is happiest with even sizes). */
export function captureRect(mon) {
  const left = Math.round(Number(mon?.left) || 0);
  const top = Math.round(Number(mon?.top) || 0);
  let w = Math.round(Number(mon?.w) || (Number(mon?.right) - Number(mon?.left)) || 0);
  let h = Math.round(Number(mon?.h) || (Number(mon?.bottom) - Number(mon?.top)) || 0);
  w -= w % 2;
  h -= h % 2;
  return { left, top, w: Math.max(2, w), h: Math.max(2, h) };
}

function encoderArgs(encoder, kbps, fps) {
  const g = String(Math.max(1, Math.round(fps * 2))); // GOP ~2 s
  const b = `${kbps}k`;
  // Small VBV buffer = frames that never sit in a rate-control queue.
  const buf = `${Math.max(200, Math.round(kbps / 2))}k`;
  const common = ["-g", g, "-bf", "0", "-b:v", b, "-maxrate", b, "-bufsize", buf];
  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-rc", "cbr", "-profile:v", "main", ...common];
    case "h264_nvenc_legacy":
      // ffmpeg < 4.3 / old NVENC SDK: no p1..p7 presets.
      return ["-c:v", "h264_nvenc", "-preset", "llhp", "-zerolatency", "1", "-rc", "cbr", "-profile:v", "main", ...common];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-async_depth", "1", "-profile:v", "main", ...common];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-usage", "ultralowlatency", "-quality", "speed", "-rc", "cbr", "-profile:v", "main", ...common];
    case "libx264":
    default:
      return [
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
        "-keyint_min", g, "-sc_threshold", "0", ...common,
      ];
  }
}

/** Pixel format the encoder takes from system memory. */
export function encoderPixFmt(encoder) {
  return encoder === "h264_qsv" || encoder === "h264_amf" ? "nv12" : "yuv420p";
}

/** Output tail shared by capture and probe: FLV framing on stdout, no buffering. */
function outputArgs() {
  return ["-an", "-flush_packets", "1", "-flvflags", "no_duration_filesize", "-f", "flv", "pipe:1"];
}

/**
 * Full ffmpeg argv for one capture session.
 * rect = monitor rect in physical desktop pixels (the agent is DPI aware).
 * Mouse is NOT drawn: the phone draws its own cursor ring.
 */
export function buildCaptureArgs({ encoder, rect, fps = 30, kbps = 4000, maxWidth = 1600 }) {
  const r = captureRect(rect);
  const out = outputSize(r.w, r.h, maxWidth);
  const vf = `scale=${out.w}:${out.h}:flags=fast_bilinear,format=${encoderPixFmt(encoder)}`;
  return {
    out,
    args: [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", "0",
      "-offset_x", String(r.left), "-offset_y", String(r.top),
      "-video_size", `${r.w}x${r.h}`,
      "-i", "desktop",
      "-vf", vf,
      ...encoderArgs(encoder, kbps, fps),
      ...outputArgs(),
    ],
  };
}

/** Tiny synthetic encode used to find a working encoder on this PC. */
export function buildProbeArgs(encoder) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30",
    "-frames:v", "5",
    "-vf", `format=${encoderPixFmt(encoder)}`,
    ...encoderArgs(encoder, 1000, 30),
    "-f", "null", "-",
  ];
}

/** Public encoder name (legacy variant is still h264_nvenc). */
export function encoderLabel(encoder) {
  return encoder === "h264_nvenc_legacy" ? "h264_nvenc" : String(encoder || "");
}

/** AVCDecoderConfigurationRecord -> { sps: Buffer[], pps: Buffer[], lengthSize }. */
export function parseAvcConfig(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 7 || buf[0] !== 1) return null;
  const lengthSize = (buf[4] & 0x03) + 1;
  let i = 5;
  const sps = [];
  const pps = [];
  const nSps = buf[i] & 0x1f;
  i += 1;
  for (let k = 0; k < nSps; k += 1) {
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    i += 2;
    if (i + len > buf.length) return null;
    sps.push(Buffer.from(buf.subarray(i, i + len)));
    i += len;
  }
  if (i >= buf.length) return { sps, pps, lengthSize };
  const nPps = buf[i];
  i += 1;
  for (let k = 0; k < nPps; k += 1) {
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    i += 2;
    if (i + len > buf.length) return null;
    pps.push(Buffer.from(buf.subarray(i, i + len)));
    i += len;
  }
  return { sps, pps, lengthSize };
}

/** Length-prefixed NAL units (AVCC) -> list of NAL payloads. */
export function splitAvcc(buf, lengthSize = 4) {
  const nals = [];
  let i = 0;
  while (i + lengthSize <= buf.length) {
    let len = 0;
    for (let k = 0; k < lengthSize; k += 1) len = len * 256 + buf[i + k];
    i += lengthSize;
    if (len <= 0 || i + len > buf.length) break;
    nals.push(buf.subarray(i, i + len));
    i += len;
  }
  return nals;
}

export function toAnnexB(nals) {
  const parts = [];
  for (const n of nals) parts.push(START, n);
  return Buffer.concat(parts);
}

/**
 * Streaming FLV demuxer for the encoder output. push(chunk) any size;
 * onAu({ data: Buffer (Annex-B), key: bool, config: bool, ms: number }) is
 * called once per complete video tag. Sequence headers update the cached
 * SPS/PPS and are not emitted on their own.
 */
export function createFlvDemuxer(onAu) {
  let buf = Buffer.alloc(0);
  let headerDone = false;
  let config = null;
  const MAX_TAG = 8_000_000;

  function handleVideoTag(data, ms) {
    if (data.length < 5) return;
    const frameType = data[0] >> 4;
    const codecId = data[0] & 0x0f;
    if (codecId !== 7) return; // AVC only
    const packetType = data[1];
    const body = data.subarray(5);
    if (packetType === 0) {
      const c = parseAvcConfig(Buffer.from(body));
      if (c && c.sps.length) config = c;
      return;
    }
    if (packetType !== 1) return; // 2 = end of sequence
    const nals = splitAvcc(body, config?.lengthSize || 4);
    if (!nals.length) return;
    const key = frameType === 1 || nals.some((n) => (n[0] & 0x1f) === 5);
    const hasSps = nals.some((n) => (n[0] & 0x1f) === 7);
    // Keep every NAL the encoder made; only prepend parameter sets to
    // keyframes that lack them (FLV keeps them in the sequence header).
    let list = nals;
    let withConfig = hasSps;
    if (key && !hasSps && config) {
      list = [...config.sps, ...config.pps, ...nals];
      withConfig = true;
    }
    onAu({ data: toAnnexB(list), key, config: withConfig, ms });
  }

  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      if (!headerDone) {
        if (buf.length < 13) return;
        if (buf[0] !== 0x46 || buf[1] !== 0x4c || buf[2] !== 0x56) throw new Error("not an FLV stream");
        const off = buf.readUInt32BE(5);
        if (buf.length < off + 4) return;
        buf = buf.subarray(off + 4); // header + PreviousTagSize0
        headerDone = true;
      }
      while (buf.length >= 11) {
        const type = buf[0] & 0x1f;
        const size = buf.readUIntBE(1, 3);
        if (size > MAX_TAG) throw new Error("FLV tag too large");
        const total = 11 + size + 4;
        if (buf.length < total) break;
        const ms = (buf[7] << 24) | buf.readUIntBE(4, 3);
        if (type === 9) handleVideoTag(buf.subarray(11, 11 + size), ms >>> 0);
        buf = buf.subarray(total);
      }
      // Never let a stale view pin a huge chunk forever.
      if (buf.length && buf.byteOffset > 1_000_000) buf = Buffer.from(buf);
    },
    get config() {
      return config;
    },
  };
}

/**
 * 16-byte "PV" header in front of every Annex-B access unit:
 *  0-1  "PV"
 *  2    kind: 0 = one monitor, 1 = all monitors
 *  3    monitor id
 *  4-5  monitor width  (u16 LE, like JPEG frames)
 *  6-7  monitor height (u16 LE)
 *  8-9  cursor x 0..10000 (u16 LE)
 *  10-11 cursor y 0..10000 (u16 LE)
 *  12   flags: bit0 keyframe, bit1 AU carries SPS/PPS
 *  13   reserved (0)
 *  14-15 sequence number (u16 LE, wraps) so the phone can spot gaps
 */
export function buildVideoHeader(meta = {}) {
  const h = Buffer.alloc(VIDEO_HEADER_BYTES);
  h[0] = VIDEO_MAGIC[0];
  h[1] = VIDEO_MAGIC[1];
  h[2] = meta.mon === "all" ? 1 : 0;
  h[3] = typeof meta.mon === "number" ? meta.mon & 0xff : 0;
  h.writeUInt16LE(clampInt(meta.w, 0, 65535, 0), 4);
  h.writeUInt16LE(clampInt(meta.h, 0, 65535, 0), 6);
  h.writeUInt16LE(clampInt((Number(meta.cx) || 0) * 10000, 0, 10000, 0), 8);
  h.writeUInt16LE(clampInt((Number(meta.cy) || 0) * 10000, 0, 10000, 0), 10);
  h[12] = (meta.key ? FLAG_KEY : 0) | (meta.config ? FLAG_CONFIG : 0);
  h[13] = 0;
  h.writeUInt16LE((Number(meta.seq) || 0) & 0xffff, 14);
  return h;
}

export function parseVideoHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < VIDEO_HEADER_BYTES || buf[0] !== 0x50 || buf[1] !== 0x56) return null;
  return {
    mon: buf[2] === 1 ? "all" : buf[3],
    w: buf.readUInt16LE(4),
    h: buf.readUInt16LE(6),
    cx: buf.readUInt16LE(8) / 10000,
    cy: buf.readUInt16LE(10) / 10000,
    key: Boolean(buf[12] & FLAG_KEY),
    config: Boolean(buf[12] & FLAG_CONFIG),
    seq: buf.readUInt16LE(14),
    data: buf.subarray(VIDEO_HEADER_BYTES),
  };
}

/**
 * Backpressure decision for one AU. state = { waitKey } (mutated).
 * Over budget: non-key AUs are dropped and the stream waits for the next
 * keyframe (a P-frame after a gap would decode as garbage). A keyframe is
 * sent unless the socket is hopelessly backed up (hardCap).
 */
export function shouldSendAu(state, { key, buffered, budget, hardCap }) {
  if (key) {
    if (buffered > hardCap) {
      state.waitKey = true;
      return false;
    }
    state.waitKey = false;
    return true;
  }
  if (state.waitKey) return false;
  if (buffered > budget) {
    state.waitKey = true;
    return false;
  }
  return true;
}

/** Socket budget in bytes: ~250 ms of video, floor 64 KB. */
export function videoBudget(kbps) {
  const bytesPerSec = (Number(kbps) || 4000) * 125;
  return { budget: Math.max(64_000, Math.round(bytesPerSec * 0.25)), hardCap: Math.max(1_000_000, Math.round(bytesPerSec * 2)) };
}

/** Short user-facing reason from ffmpeg stderr (Indonesian prefix kept by caller). */
export function ffmpegReason(stderr) {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return last.slice(0, 160);
}
