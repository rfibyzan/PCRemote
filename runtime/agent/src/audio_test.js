// node src/audio_test.js — PC audio wire format + Ogg depacketizer (no Windows deps).
import assert from "node:assert/strict";
import { audioHeader, audioKbps, createOggDepacketizer, ffmpegAudioArgs, parseFmtLine, pickOpusEncoder } from "./audioproto.js";

const h = audioHeader(65537, { channels: 2, frameMs: 20 });
assert.equal(h.length, 8);
assert.deepEqual([...h.subarray(0, 4)], [0x50, 0x41, 1, 2]);
assert.equal(h.readUInt16LE(4), 1, "seq wraps at 16 bits");
assert.equal(h.readUInt16LE(6), 20);

assert.equal(audioKbps([]), 0);
assert.equal(audioKbps(["wifi", "usb"]), 96);
assert.equal(audioKbps(["wifi", "internet"]), 48, "any tunnel phone -> small bitrate");

assert.equal(parseFmtLine("fmt 48000"), 48000);
assert.equal(parseFmtLine("fmt 44100\r"), 44100);
assert.equal(parseFmtLine("err wasapi 0x88890004"), 0);

assert.equal(pickOpusEncoder(" A....D libopus              libopus Opus (codec opus)\n A....D opus  Opus"), "libopus");
assert.equal(pickOpusEncoder(" A..X.. opus                 Opus"), "opus");
assert.equal(pickOpusEncoder(" V....D libx264 H.264"), "");

const args = ffmpegAudioArgs({ rate: 44100, kbps: 48, encoder: "libopus" });
assert.ok(args.join(" ").includes("-ar 44100 -ac 2 -i pipe:0"));
assert.ok(args.join(" ").includes("-b:a 48k"));
assert.equal(args.at(-1), "pipe:1");
assert.ok(ffmpegAudioArgs({ rate: 48000, kbps: 96, encoder: "opus" }).includes("-strict"));

// Build Ogg pages by hand.
function page(packets, { bos = false, cont = false, lacingOverride } = {}) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const lac = lacingOverride || lacing;
  const hdr = Buffer.alloc(27);
  hdr.write("OggS", 0);
  hdr[5] = (bos ? 2 : 0) | (cont ? 1 : 0);
  hdr[26] = lac.length;
  return Buffer.concat([hdr, Buffer.from(lac), ...packets]);
}
const got = [];
const push = createOggDepacketizer((p) => got.push(p.toString("latin1")));
const head = Buffer.from("OpusHead-xxxxxxxxxxx");
const tags = Buffer.from("OpusTags-yy");
const a = Buffer.from("A".repeat(10));
const big = Buffer.from("B".repeat(300));
const stream = Buffer.concat([page([head], { bos: true }), page([tags]), page([a]), page([big])]);
// feed in awkward chunks
for (let i = 0; i < stream.length; i += 7) push(stream.subarray(i, i + 7));
assert.deepEqual(got, ["A".repeat(10), "B".repeat(300)], "headers skipped, big packet reassembled");

// Packet continued across two pages: first page ends with lacing 255.
got.length = 0;
const c1 = Buffer.from("C".repeat(255));
const c2 = Buffer.from("C".repeat(5));
push(Buffer.concat([page([c1], { lacingOverride: [255] }), page([c2], { cont: true })]));
assert.deepEqual(got, ["C".repeat(260)], "continued packet joined");

// Garbage before a page is skipped.
got.length = 0;
push(Buffer.concat([Buffer.from("junk"), page([Buffer.from("D")])]));
assert.deepEqual(got, ["D"]);

console.log("audio_test: ok");
