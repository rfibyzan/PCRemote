/**
 * PC sound wire format (pure, tested by audioproto.test.js). Agent side:
 * runtime/agent/src/audioproto.js. Binary "PA" = 8-byte header + one Opus
 * packet (20 ms, 48 kHz stereo).
 */
export function isAudioPacket(buf) {
  if (!buf || buf.byteLength < 9) return false;
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf, 0, 2);
  return b[0] === 0x50 && b[1] === 0x41;
}

export function parseAudioPacket(buf) {
  if (!isAudioPacket(buf)) return null;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return {
    version: bytes[2],
    channels: bytes[3],
    seq: bytes[4] | (bytes[5] << 8),
    frameMs: bytes[6] | (bytes[7] << 8),
    data: bytes.subarray(8),
  };
}

/** Does this PC's agent stream sound? (hello.features from agent >= 1.3) */
export function agentHasAudio(hello) {
  return Array.isArray(hello?.features) && hello.features.includes("audio");
}
