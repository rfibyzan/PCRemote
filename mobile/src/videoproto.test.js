// node src/videoproto.test.js
import assert from "node:assert/strict";
import {
  REMOTE_KBPS_CAP,
  fmtKbps,
  fpsValue,
  isVideoPacket,
  parseVideoPacket,
  qValue,
  qualityView,
  stepLevel,
  videoFps,
  videoParams,
  videoWidth,
} from "./videoproto.js";

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
  // presets: Low 2 Mbps/30 fps/720p, Mid 5 Mbps/30/1080p, High 10 Mbps/60/1080p
  assert.deepEqual(videoParams({ q: "lite" }), { fps: 30, kbps: 2000, width: 1280 });
  assert.deepEqual(videoParams({ q: "low" }), { fps: 30, kbps: 5000, width: 1920 });
  assert.deepEqual(videoParams({ q: "med" }), { fps: 30, kbps: 5000, width: 1920 });
  assert.deepEqual(videoParams({ q: "high" }), { fps: 60, kbps: 10000, width: 1920 });
  assert.deepEqual(videoParams({ q: "super" }), { fps: 60, kbps: 10000, width: 1920 });
  assert.equal(videoParams({ q: "nope" }).kbps, 5000, "unknown preset = Mid");
  // bitrate: +/-25 % of preset per qStep, 500..20000
  assert.equal(videoParams({ q: "low", qStep: 2 }).kbps, 7500);
  assert.equal(videoParams({ q: "low", qStep: -2 }).kbps, 2500);
  assert.equal(videoParams({ q: "lite", qStep: -5 }).kbps, 500, "floor");
  assert.equal(videoParams({ q: "high", qStep: 4 }).kbps, 20000);
  assert.equal(videoParams({ q: "high", qStep: 8 }).kbps, 20000, "ceiling");
  // auto width: < 3000 kbps -> 1280, else 1920
  assert.equal(videoWidth(2999), 1280);
  assert.equal(videoWidth(3000), 1920);
  assert.equal(videoParams({ q: "low", qStep: -2 }).width, 1280, "2.5 Mbps -> 720p");
  assert.equal(videoParams({ q: "lite", qStep: 2 }).width, 1920, "3 Mbps -> 1080p");
  // remote cap, and the width follows the capped bitrate
  assert.deepEqual(videoParams({ q: "high" }, "remote"), { fps: 60, kbps: REMOTE_KBPS_CAP, width: 1280 });
  assert.equal(videoParams({ q: "lite" }, "Remote").kbps, 2000, "under the cap stays");
  assert.equal(videoParams({ q: "high" }, "wifi").kbps, 10000);
}
{
  // conversion: one level, both codecs
  const lvl = (q, qStep, fpsStep = 0) => [qValue(q, qStep), videoParams({ q, qStep, fpsStep }).kbps];
  assert.deepEqual(lvl("lite", 0), [18, 2000]);
  assert.deepEqual(lvl("low", 0), [26, 5000]);
  assert.deepEqual(lvl("high", 0), [40, 10000]);
  assert.deepEqual(lvl("low", 1), [34, 6250]);
  assert.deepEqual(lvl("low", -1), [18, 3750]);
  assert.deepEqual(lvl("high", 2), [56, 15000]);
  assert.deepEqual(lvl("lite", -2), [18, 1000], "JPEG floor, H.264 still moves");
  // fps mapping: JPEG +2/step (max 30), H.264 +5/step (10..60), same direction
  assert.deepEqual([fpsValue("lite", 0), videoFps("lite", 0)], [6, 30]);
  assert.deepEqual([fpsValue("low", 0), videoFps("low", 0)], [13, 30]);
  assert.deepEqual([fpsValue("high", 0), videoFps("high", 0)], [22, 60]);
  assert.deepEqual([fpsValue("low", 2), videoFps("low", 2)], [17, 40]);
  assert.deepEqual([fpsValue("low", 6), videoFps("low", 6)], [25, 60]);
  assert.deepEqual([fpsValue("low", 10), videoFps("low", 10)], [30, 60], "JPEG max 30");
  assert.deepEqual([fpsValue("high", 4), videoFps("high", 4)], [30, 60]);
  assert.deepEqual([fpsValue("high", -2), videoFps("high", -2)], [18, 50]);
  assert.deepEqual([fpsValue("lite", -5), videoFps("lite", -5)], [1, 10], "both floors");
  for (const q of ["lite", "low", "high"]) {
    for (let f = -5; f < 10; f++) {
      assert.ok(fpsValue(q, f + 1) >= fpsValue(q, f) && videoFps(q, f + 1) >= videoFps(q, f), `fps monotonic ${q} ${f}`);
    }
  }
}
{
  // stepLevel skips dead zones, null at the limit
  const v = (n) => Math.max(0, n);
  assert.equal(stepLevel(-3, 1, v, -5, 8), 1);
  assert.equal(stepLevel(-3, -1, v, -5, 8), null);
  assert.equal(stepLevel(8, 1, (n) => n, -5, 8), null);
  // JPEG view
  const j = qualityView({ q: "low", qStep: 0, fpsStep: 0 });
  assert.equal(j.video, false);
  assert.equal(j.qText, "Q26");
  assert.equal(j.fpsText, "13 fps");
  assert.equal(j.qCaption, "");
  assert.equal(j.qDown, -1);
  assert.equal(j.qUp, 1);
  assert.equal(qualityView({ q: "lite" }).qDown, null, "Q18 is the JPEG floor");
  assert.equal(qualityView({ q: "low", fpsStep: 10 }).fpsUp, null, "JPEG 30 fps max");
  assert.equal(qualityView({ q: "high", fpsStep: 4 }).fpsUp, null, "JPEG 30 fps at +4");
  assert.equal(qualityView({ q: "lite", qStep: -2 }).qUp, 1, "JPEG + leaves the H.264-only zone in one press");
  // H.264 view: same level, other names
  const h = qualityView({ q: "low", qStep: 1, fpsStep: 2 }, { video: true });
  assert.equal(h.video, true);
  assert.equal(h.qText, "6.3 Mbps");
  assert.equal(h.qCaption, "Bitrate 1080p");
  assert.equal(h.fpsText, "40 fps");
  assert.equal(qualityView({ q: "lite" }, { video: true }).qCaption, "Bitrate 720p");
  assert.equal(qualityView({ q: "lite" }, { video: true }).qDown, -1, "H.264 can go below Low");
  assert.equal(qualityView({ q: "high" }, { video: true }).fpsUp, null, "H.264 60 fps max");
  assert.equal(qualityView({ q: "high", fpsStep: 4 }, { video: true }).fpsDown, -1, "skip 60-fps dead zone");
  assert.equal(qualityView({ q: "high", qStep: 4 }, { video: true }).qUp, null, "20 Mbps max");
  assert.equal(qualityView({ q: "lite", qStep: -3 }, { video: true }).qDown, null, "500 kbps floor");
  // remote: shows the capped value, + disabled at the cap
  const r = qualityView({ q: "high" }, { video: true, link: "remote" });
  assert.equal(r.qText, "2.5 Mbps");
  assert.equal(r.qCaption, "Batas internet");
  assert.equal(r.qUp, null);
  const r2 = qualityView({ q: "lite" }, { video: true, link: "remote" });
  assert.equal(r2.qText, "2 Mbps");
  assert.equal(r2.qUp, 1);
  assert.equal(qualityView({ q: "lite", qStep: 1 }, { video: true, link: "remote" }).qUp, null);
}
{
  assert.equal(fmtKbps(1500), "1.5 Mbps");
  assert.equal(fmtKbps(4000), "4 Mbps");
  assert.equal(fmtKbps(800), "800 kbps");
}
console.log("videoproto tests ok");
