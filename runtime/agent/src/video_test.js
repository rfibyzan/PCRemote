// Tests for the pure H.264 stream helpers (src/videoenc.js). Runs anywhere:
// no koffi / Windows. If an `ffmpeg` with libx264 is on PATH, also runs a
// real encode through the FLV demuxer (gdigrab swapped for lavfi).
import { execFileSync, spawnSync } from "node:child_process";
import {
  ENCODER_CANDIDATES,
  buildCaptureArgs,
  buildProbeArgs,
  buildVideoHeader,
  captureRect,
  createFlvDemuxer,
  encoderLabel,
  encoderPixFmt,
  outputSize,
  parseAvcConfig,
  parseVideoHeader,
  shouldSendAu,
  splitAvcc,
  videoBudget,
  videoRequest,
} from "./videoenc.js";

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}  ${err?.stack || err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

test("outputSize keeps aspect, even, no upscale", () => {
  eq(outputSize(1920, 1080, 1600), { w: 1600, h: 900 }, "1080p");
  eq(outputSize(1280, 720, 1600), { w: 1280, h: 720 }, "no upscale");
  eq(outputSize(2560, 1440, 1600), { w: 1600, h: 900 }, "1440p");
  const s = outputSize(1366, 768, 1600);
  assert(s.w % 2 === 0 && s.h % 2 === 0, "even");
  const tall = outputSize(1080, 1920, 1600);
  assert(tall.h <= 1600 && tall.w % 2 === 0, "portrait monitor capped");
  const all = outputSize(3840 + 1920, 1080, 1600);
  assert(all.w === 1600 && all.h % 2 === 0, "multi-monitor");
});

test("captureRect is even and keeps negative offsets", () => {
  eq(captureRect({ left: -1920, top: 0, w: 1921, h: 1081 }), { left: -1920, top: 0, w: 1920, h: 1080 }, "rect");
  eq(captureRect({ left: 10, top: 20, right: 1930, bottom: 1100 }), { left: 10, top: 20, w: 1920, h: 1080 }, "from right/bottom");
});

test("videoRequest clamps", () => {
  eq(videoRequest({}), { fps: 30, kbps: 4000, maxWidth: 1600 }, "defaults");
  eq(videoRequest({ fps: 999, kbps: 1, width: 99999 }), { fps: 60, kbps: 300, maxWidth: 1920 }, "clamped");
});

test("capture args: gdigrab monitor rect, no mouse, no B-frames, GOP 2 s, FLV out", () => {
  const { args, out } = buildCaptureArgs({ encoder: "libx264", rect: { left: 1920, top: 0, w: 2560, h: 1440 }, fps: 30, kbps: 4000, maxWidth: 1600 });
  const s = args.join(" ");
  eq(out, { w: 1600, h: 900 }, "out size");
  assert(s.includes("-f gdigrab"), "gdigrab");
  assert(s.includes("-draw_mouse 0"), "no mouse");
  assert(s.includes("-offset_x 1920 -offset_y 0"), "offset");
  assert(s.includes("-video_size 2560x1440"), "size");
  assert(s.includes("scale=1600:900"), "scale");
  assert(s.includes("-bf 0"), "no B");
  assert(s.includes("-g 60"), "GOP");
  assert(s.includes("-tune zerolatency") && s.includes("-preset ultrafast"), "x264 low latency");
  assert(s.includes("-profile:v baseline"), "baseline");
  assert(s.endsWith("-f flv pipe:1"), "flv stdout");
  for (const enc of ENCODER_CANDIDATES) {
    const a = buildCaptureArgs({ encoder: enc, rect: { left: 0, top: 0, w: 1920, h: 1080 } }).args.join(" ");
    assert(a.includes("-bf 0"), `${enc} no B`);
    assert(a.includes(`format=${encoderPixFmt(enc)}`), `${enc} pix fmt`);
    assert(buildProbeArgs(enc).includes("null"), `${enc} probe`);
  }
  eq(encoderLabel("h264_nvenc_legacy"), "h264_nvenc", "label");
});

test("PV header roundtrip", () => {
  const h = buildVideoHeader({ mon: 2, w: 2560, h: 1440, cx: 0.25, cy: 0.75, key: true, config: true, seq: 65537 });
  eq([h[0], h[1]], [0x50, 0x56], "magic");
  assert(h.length === 16, "16 bytes");
  const p = parseVideoHeader(Buffer.concat([h, Buffer.from([0, 0, 0, 1, 0x65])]));
  eq({ mon: p.mon, w: p.w, h: p.h, cx: p.cx, cy: p.cy, key: p.key, config: p.config, seq: p.seq }, { mon: 2, w: 2560, h: 1440, cx: 0.25, cy: 0.75, key: true, config: true, seq: 1 }, "fields");
  eq(p.data.length, 5, "payload");
  const all = parseVideoHeader(buildVideoHeader({ mon: "all", w: 10, h: 10 }));
  eq(all.mon, "all", "all monitors");
  assert(parseVideoHeader(Buffer.from("PR0123456789abcd")) === null, "JPEG magic rejected");
});

test("backpressure: drop P-frames over budget, then wait for keyframe", () => {
  const st = { waitKey: false };
  const b = { budget: 100, hardCap: 1000 };
  assert(shouldSendAu(st, { key: false, buffered: 10, ...b }), "send under budget");
  assert(!shouldSendAu(st, { key: false, buffered: 500, ...b }), "drop over budget");
  assert(!shouldSendAu(st, { key: false, buffered: 0, ...b }), "still waiting for key");
  assert(!shouldSendAu(st, { key: true, buffered: 5000, ...b }), "key dropped over hard cap");
  assert(shouldSendAu(st, { key: true, buffered: 500, ...b }), "key sent");
  assert(shouldSendAu(st, { key: false, buffered: 0, ...b }), "resumes after key");
  const vb = videoBudget(4000);
  assert(vb.budget === 125_000 && vb.hardCap === 1_000_000, "budget numbers");
});

// ---- synthetic FLV -------------------------------------------------------
function flvHeader() {
  const h = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9]);
  return Buffer.concat([h, Buffer.alloc(4)]);
}
function flvTag(type, ms, data) {
  const t = Buffer.alloc(11);
  t[0] = type;
  t.writeUIntBE(data.length, 1, 3);
  t.writeUIntBE(ms & 0xffffff, 4, 3);
  t[7] = (ms >>> 24) & 0xff;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + data.length);
  return Buffer.concat([t, data, prev]);
}
const SPS = Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0xaa]);
const PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
function avcConfig() {
  return Buffer.concat([
    Buffer.from([1, 0x42, 0xc0, 0x1f, 0xff, 0xe1]),
    Buffer.from([0, SPS.length]), SPS,
    Buffer.from([1, 0, PPS.length]), PPS,
  ]);
}
function avcc(nals) {
  return Buffer.concat(nals.flatMap((n) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(n.length);
    return [l, n];
  }));
}
function videoTag(ms, key, packetType, body) {
  return flvTag(9, ms, Buffer.concat([Buffer.from([(key ? 0x10 : 0x20) | 7, packetType, 0, 0, 0]), body]));
}

test("parseAvcConfig / splitAvcc", () => {
  const c = parseAvcConfig(avcConfig());
  eq(c.lengthSize, 4, "length size");
  eq(c.sps[0], SPS, "sps");
  eq(c.pps[0], PPS, "pps");
  const n = splitAvcc(avcc([Buffer.from([0x65, 1, 2]), Buffer.from([0x06, 9])]));
  eq(n.length, 2, "2 nals");
});

test("FLV demuxer: AU per tag, SPS/PPS prepended to keyframes, any chunking", () => {
  const idr = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x33]);
  const p1 = Buffer.from([0x41, 0x9a, 0x02]);
  const p2 = Buffer.from([0x41, 0x9a, 0x04, 0x05]);
  const stream = Buffer.concat([
    flvHeader(),
    flvTag(18, 0, Buffer.from([2, 0, 10])), // script tag, ignored
    videoTag(0, true, 0, avcConfig()),
    videoTag(0, true, 1, avcc([idr])),
    videoTag(33, false, 1, avcc([p1])),
    videoTag(66, false, 1, avcc([p2])),
    videoTag(0x1000000 + 5, true, 1, avcc([idr])), // extended timestamp
  ]);
  for (const step of [1, 3, 7, 64, stream.length]) {
    const aus = [];
    const d = createFlvDemuxer((au) => aus.push(au));
    for (let i = 0; i < stream.length; i += step) d.push(stream.subarray(i, i + step));
    eq(aus.length, 4, `step ${step}: AU count`);
    eq(aus.map((a) => a.key), [true, false, false, true], "key flags");
    eq(aus.map((a) => a.config), [true, false, false, true], "config flags");
    const start = Buffer.from([0, 0, 0, 1]);
    eq(aus[0].data, Buffer.concat([start, SPS, start, PPS, start, idr]), "annex-b keyframe");
    eq(aus[1].data, Buffer.concat([start, p1]), "annex-b P");
    eq(aus[3].ms, 0x1000000 + 5, "extended ts");
  }
});

test("FLV demuxer rejects non-FLV", () => {
  const d = createFlvDemuxer(() => {});
  let threw = false;
  try {
    d.push(Buffer.from("this is not flv at all"));
  } catch {
    threw = true;
  }
  assert(threw, "throws");
});

// ---- real encoder (optional) ---------------------------------------------
function hasLibx264() {
  try {
    return /libx264/.test(execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
}

if (hasLibx264()) {
  test("real libx264 -> FLV -> Annex-B AUs decode back with ffmpeg", () => {
    const { args } = buildCaptureArgs({ encoder: "libx264", rect: { left: 0, top: 0, w: 1920, h: 1080 }, fps: 30, kbps: 2000, maxWidth: 640 });
    // Swap the gdigrab input for a synthetic one; keep every encoder/output arg.
    const i = args.indexOf("gdigrab");
    const iEnd = args.indexOf("desktop");
    const real = [...args.slice(0, i - 1), "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=5", ...args.slice(iEnd + 1)];
    const r = spawnSync("ffmpeg", real, { maxBuffer: 50_000_000 });
    assert(r.status === 0, `ffmpeg failed: ${String(r.stderr)}`);
    const aus = [];
    const d = createFlvDemuxer((au) => aus.push(au));
    d.push(r.stdout);
    assert(aus.length === 150, `150 AUs, got ${aus.length}`);
    const keys = aus.map((a, n) => (a.key ? n : -1)).filter((n) => n >= 0);
    eq(keys.slice(0, 3), [0, 60, 120], "IDR every 2 s");
    assert(aus.filter((a) => a.key).every((a) => a.config), "every keyframe carries SPS/PPS");
    // Join mid-stream at the 2nd keyframe: must decode on its own.
    const tail = Buffer.concat(aus.slice(60).map((a) => a.data));
    const dec = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-f", "null", "-"], { input: tail });
    assert(dec.status === 0 && !String(dec.stderr).trim(), `decode errors: ${String(dec.stderr)}`);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,has_b_frames,profile", "-of", "json", "-f", "h264", "pipe:0"], { input: tail });
    const info = JSON.parse(String(probe.stdout)).streams[0];
    eq([info.width, info.height], [640, 360], "scaled size");
    eq(info.has_b_frames, 0, "no B-frames");
  });
} else {
  console.log("SKIP  real libx264 encode (no ffmpeg/libx264 on PATH)");
}

if (failed) {
  console.log(`${failed} video test(s) failed`);
  process.exit(1);
}
console.log("video tests ok");
