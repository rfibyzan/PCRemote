// Pure parts of PC audio -> phone (no Windows deps, tested by audio_test.js).
//
// Wire: binary "PA" message = 8-byte header + one Opus packet (20 ms, 48 kHz
// stereo). The phone decodes with MediaCodec "audio/opus" (its own OpusHead).
//   0-1  "PA"
//   2    version (1)
//   3    channels (2)
//   4-5  seq (u16 LE, wraps)
//   6-7  frame duration in ms (u16 LE)

export const AUDIO_MAGIC = [0x50, 0x41]; // "PA"
export const AUDIO_HEADER_BYTES = 8;

export function audioHeader(seq, { channels = 2, frameMs = 20 } = {}) {
  const h = Buffer.alloc(AUDIO_HEADER_BYTES);
  h[0] = AUDIO_MAGIC[0];
  h[1] = AUDIO_MAGIC[1];
  h[2] = 1;
  h[3] = channels & 0xff;
  h.writeUInt16LE(seq & 0xffff, 4);
  h.writeUInt16LE(frameMs & 0xffff, 6);
  return h;
}

/** Opus bitrate (kbps) for the phones listening: the tunnel is capped at
 * 2.5 Mbps for video, so stay small there; Wi-Fi/USB get near-transparent. */
export function audioKbps(links) {
  const list = [...(links || [])];
  if (!list.length) return 0;
  return list.some((l) => l === "internet") ? 48 : 96;
}

/** ffmpeg argv: s16le stereo at the device rate on stdin -> Ogg Opus pages
 * on stdout, one 20 ms packet per page (page_duration) so nothing waits. */
export function ffmpegAudioArgs({ rate, kbps, encoder = "libopus" }) {
  const a = ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(rate), "-ac", "2", "-i", "pipe:0"];
  a.push("-c:a", encoder, "-b:a", `${kbps}k`, "-ar", "48000", "-ac", "2");
  if (encoder === "libopus") a.push("-application", "lowdelay", "-frame_duration", "20", "-vbr", "on");
  else a.push("-strict", "-2"); // ffmpeg's own (experimental) opus encoder
  a.push("-flush_packets", "1", "-page_duration", "20000", "-f", "ogg", "pipe:1");
  return a;
}

/** Which Opus encoder this ffmpeg has (`ffmpeg -encoders` text), or "". */
export function pickOpusEncoder(encodersText) {
  const t = String(encodersText || "");
  if (/^\s*A\S*\s+libopus\b/m.test(t)) return "libopus";
  if (/^\s*A\S*\s+opus\b/m.test(t)) return "opus";
  return "";
}

/** "fmt 48000" from PCRemoteAudio.exe stderr -> 48000, else 0. */
export function parseFmtLine(line) {
  const m = /^fmt\s+(\d{4,6})\s*$/.exec(String(line || "").trim());
  return m ? Number(m[1]) : 0;
}

/**
 * Ogg byte stream -> Opus packets. Handles pages split across chunks and
 * packets continued across pages (lacing 255). Skips the two header packets
 * (OpusHead, OpusTags) of each logical stream.
 */
export function createOggDepacketizer(onPacket) {
  let buf = Buffer.alloc(0);
  let partial = [];
  let headersLeft = 2;
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      const at = buf.indexOf("OggS");
      if (at < 0) {
        if (buf.length > 3) buf = buf.subarray(buf.length - 3);
        return;
      }
      if (at > 0) buf = buf.subarray(at);
      if (buf.length < 27) return;
      const flags = buf[5];
      const segs = buf[26];
      if (buf.length < 27 + segs) return;
      let bodyLen = 0;
      for (let i = 0; i < segs; i++) bodyLen += buf[27 + i];
      const total = 27 + segs + bodyLen;
      if (buf.length < total) return;
      if (flags & 0x02) {
        // beginning of a (new) stream: its own headers come first
        headersLeft = 2;
        partial = [];
      }
      if (!(flags & 0x01)) partial = []; // not a continuation: drop stray pieces
      let off = 27 + segs;
      for (let i = 0; i < segs; i++) {
        const len = buf[27 + i];
        partial.push(buf.subarray(off, off + len));
        off += len;
        if (len < 255) {
          const pkt = partial.length === 1 ? Buffer.from(partial[0]) : Buffer.concat(partial);
          partial = [];
          if (headersLeft > 0) headersLeft -= 1;
          else if (pkt.length) onPacket(pkt);
        }
      }
      buf = buf.subarray(total);
    }
  };
}
