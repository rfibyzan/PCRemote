// node src/videoproto.test.js
import assert from "node:assert/strict";
import { fmtKbps, isVideoPacket, parseVideoPacket, videoParams } from "./videoproto.js";

function header({ mon = 0, all = false, w = 1920, h = 1080, cx = 0.5, cy = 0.25, key = false, config = false, seq = 7 }) {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  b[0] = 0x50;
  b[1] = 0x56;
  b[2] = all ? 1 : 0;
  b[3] = mon;
  v.setUint16(4, w, true);
  v.setUint16(6, h, true);
  v.setUint16(8, Math.round(cx * 10000), true);
  v.setUint16(10, Math.round(cy * 10000), true);
  b[12] = (key ? 1 : 0) | (config ? 2 : 0);
  v.setUint16(14, seq, true);
  return b;
}

{
  const au = [0, 0, 0, 1, 0x65, 0x88];
  const buf = new Uint8Array([...header({ mon: 1, key: true, config: true }), ...au]);
  const p = parseVideoPacket(buf.buffer);
  assert.equal(p.mon, 1);
  assert.equal(p.w, 1920);
  assert.equal(p.h, 1080);
  assert.equal(p.cx, 0.5);
  assert.equal(p.cy, 0.25);
  assert.equal(p.key, true);
  assert.equal(p.config, true);
  assert.equal(p.seq, 7);
  assert.deepEqual([...p.data], au);
  assert.equal(isVideoPacket(buf.buffer), true);
  // subarray input keeps offsets right
  const big = new Uint8Array(40);
  big.set(buf, 10);
  const q = parseVideoPacket(big.subarray(10, 10 + buf.length));
  assert.equal(q.w, 1920);
  assert.deepEqual([...q.data], au);
  assert.equal(parseVideoPacket(new Uint8Array([...header({ all: true }), 1]).buffer).mon, "all");
}
{
  const jpeg = new Uint8Array(32);
  jpeg[0] = 0x50;
  jpeg[1] = 0x52;
  assert.equal(parseVideoPacket(jpeg.buffer), null, "PR is not video");
  assert.equal(isVideoPacket(jpeg.buffer), false);
  assert.equal(parseVideoPacket(header({}).buffer), null, "header without payload");
}
{
  assert.deepEqual(videoParams({ q: "lite" }), { fps: 20, kbps: 1500, width: 1280 });
  assert.deepEqual(videoParams({ q: "low" }), { fps: 30, kbps: 4000, width: 1600 });
  assert.deepEqual(videoParams({ q: "high" }), { fps: 30, kbps: 8000, width: 1600 });
  assert.equal(videoParams({ q: "high" }, "remote").kbps, 2500, "tunnel cap");
  assert.equal(videoParams({ q: "low", qStep: 2 }).kbps, 6000);
  assert.equal(videoParams({ q: "low", qStep: -5 }).kbps, 1000);
  assert.equal(videoParams({ q: "lite", qStep: -5 }).kbps, 500, "floor");
  assert.equal(videoParams({ q: "low", fpsStep: 10 }).fps, 60, "fps cap");
  assert.equal(videoParams({ q: "low", fpsStep: -5 }).fps, 15);
  assert.equal(videoParams({ q: "nope" }).kbps, 4000, "unknown preset = Mid");
  assert.equal(fmtKbps(1500), "1.5 Mbps");
  assert.equal(fmtKbps(4000), "4 Mbps");
  assert.equal(fmtKbps(800), "800 kbps");
}
console.log("videoproto tests ok");
