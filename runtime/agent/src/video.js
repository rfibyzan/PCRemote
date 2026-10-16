/**
 * Opt-in H.264 screen stream (beta). JPEG stays the default.
 *
 * Phone -> {t:"video", on:true, fps?, kbps?, width?}
 * Agent -> {t:"videoState", on, codec:"h264", encoder, capture, w, h, mon, reason?}
 *          encoder is the status label, e.g. "ddagrab+h264_nvenc".
 *       -> binary "PV" frames: 16-byte header (videoenc.js) + one Annex-B AU
 *
 * One ffmpeg per phone that asked for video, capturing that phone's current
 * monitor with ddagrab (Desktop Duplication) when ffmpeg has it and the
 * monitor maps to a DXGI output, else gdigrab (cursor not drawn either way:
 * the phone draws its own ring). gdigrab's per-frame CAPTUREBLT BitBlt makes
 * the real cursor on the PC flicker, so a ddagrab session that dies before
 * its first frame (or produces none within DDA_FIRST_FRAME_MS) falls back to
 * gdigrab with the same encoder.
 * While a phone's video is ACTIVE (first AU produced), screenLoop skips JPEG
 * for it and only sends cursor updates. Anything that goes wrong (ffmpeg
 * missing, no working encoder, repeated crashes) ends with
 * {t:"videoState", on:false, reason} and the phone is back on JPEG.
 */
import { execFile, spawn } from "node:child_process";
import { findFfmpeg } from "./webcam.js";
import {
  ENCODER_CANDIDATES,
  buildCaptureArgs,
  chooseCapture,
  ffmpegHasDdagrab,
  streamLabel,
  buildProbeArgs,
  buildVideoHeader,
  createFlvDemuxer,
  encoderLabel,
  ffmpegReason,
  shouldSendAu,
  videoBudget,
  videoRequest,
} from "./videoenc.js";

const probeCache = new Map(); // `${bin}|${encoder}` -> Promise<boolean>
const ddaCache = new Map(); // bin -> Promise<boolean>

/** No AU from a ddagrab session this long after spawn -> fall back to gdigrab. */
export const DDA_FIRST_FRAME_MS = 5000;

/** Does this ffmpeg build have the ddagrab source (ffmpeg >= 6.1, Windows)? Probed once per binary. */
function probeDdagrab(bin) {
  if (!ddaCache.has(bin)) {
    ddaCache.set(
      bin,
      new Promise((resolve) => {
        execFile(bin, ["-hide_banner", "-filters"], { windowsHide: true, timeout: 12000, maxBuffer: 4_000_000 }, (err, stdout) => {
          resolve(!err && ffmpegHasDdagrab(stdout));
        });
      }),
    );
  }
  return ddaCache.get(bin);
}

function probeEncoder(bin, encoder) {
  const key = `${bin}|${encoder}`;
  if (!probeCache.has(key)) {
    probeCache.set(
      key,
      new Promise((resolve) => {
        execFile(bin, buildProbeArgs(encoder), { windowsHide: true, timeout: 12000, maxBuffer: 1_000_000 }, (err) => {
          resolve(!err);
        });
      }),
    );
  }
  return probeCache.get(key);
}

/** First encoder after `skip` (a Set of names) that passes the probe. */
async function pickEncoder(bin, skip) {
  const forced = String(process.env.PCREMOTE_H264_ENCODER || "").trim();
  const list = forced ? [forced] : ENCODER_CANDIDATES;
  for (const enc of list) {
    if (skip.has(enc)) continue;
    if (await probeEncoder(bin, enc)) return enc;
  }
  return "";
}

export function createVideoManager({ monitorFor, cursorFor, dxgiOutputs = () => [], onAu = () => {}, onStart = () => {}, log = () => {} }) {
  function sendJson(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function vs(ws) {
    if (!ws.video) {
      ws.video = {
        want: false,
        req: videoRequest({}),
        proc: null,
        sig: "",
        gen: 0,
        active: false,
        starting: false,
        badEnc: new Set(),
        badCap: new Set(),
        crashes: [],
        waitKey: true,
        seq: 0,
      };
    }
    return ws.video;
  }

  function desired(ws) {
    const v = ws.video;
    return Boolean(v && v.want && ws.readyState === 1 && ws.wantsScreen && !ws.wantsCam);
  }

  function killProc(v) {
    const p = v.proc;
    v.proc = null;
    v.sig = "";
    if (p) {
      try {
        p.kill();
      } catch {
        // already gone
      }
    }
  }

  function deactivate(ws, reason = "") {
    const v = vs(ws);
    v.gen += 1;
    killProc(v);
    const was = v.active || v.starting;
    v.active = false;
    v.starting = false;
    if (was || reason) sendJson(ws, { t: "videoState", on: false, codec: "h264", ...(reason ? { reason } : {}) });
  }

  function fail(ws, reason) {
    const v = vs(ws);
    v.want = false;
    log(`video: ${reason}`);
    deactivate(ws, reason || "video gagal");
  }

  function sigFor(ws, mon) {
    const v = vs(ws);
    return `${mon.id}:${mon.left}:${mon.top}:${mon.w}:${mon.h}:${v.req.fps}:${v.req.kbps}:${v.req.maxWidth}`;
  }

  async function start(ws) {
    const v = vs(ws);
    const gen = ++v.gen;
    killProc(v);
    v.starting = true;
    const bin = findFfmpeg();
    if (!bin) return fail(ws, "ffmpeg tidak ditemukan di PC");
    const encoder = await pickEncoder(bin, v.badEnc);
    const ddaSupported = await probeDdagrab(bin);
    if (gen !== v.gen || !desired(ws)) return;
    if (!encoder) {
      const last = v.lastWhy ? ` (${v.lastWhy})` : "";
      return fail(ws, `tidak ada encoder H.264 yang jalan di ffmpeg PC ini${last}`);
    }
    const mon = monitorFor(ws);
    if (!mon || !mon.w || !mon.h) return fail(ws, "monitor tidak ditemukan");
    let outputs = [];
    try {
      outputs = ddaSupported ? dxgiOutputs() || [] : [];
    } catch {
      outputs = [];
    }
    const plan = chooseCapture({ supported: ddaSupported, bad: v.badCap, rect: mon, outputs, forced: process.env.PCREMOTE_CAPTURE });
    const { args, out, capture } = buildCaptureArgs({ encoder, rect: mon, ...v.req, capture: plan.capture, dda: plan.dda });
    const label = streamLabel(capture, encoder);
    if (capture !== "ddagrab" && plan.why) log(`video: pakai gdigrab (${plan.why})`);
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return fail(ws, `ffmpeg gagal jalan: ${err?.message || err}`);
    }
    v.proc = child;
    v.sig = sigFor(ws, mon);
    v.waitKey = true;
    let produced = 0;
    let stderr = "";
    let ddaTimedOut = false;
    const startedAt = Date.now();
    // ddagrab that opens but never delivers a frame (secure desktop, odd
    // driver): give up on it and let the exit handler restart on gdigrab.
    const watchdog =
      capture === "ddagrab"
        ? setTimeout(() => {
            if (gen !== v.gen || produced || v.proc !== child) return;
            ddaTimedOut = true;
            try {
              child.kill();
            } catch {
              // already gone
            }
          }, DDA_FIRST_FRAME_MS)
        : null;
    if (watchdog && typeof watchdog.unref === "function") watchdog.unref();
    const { budget, hardCap } = videoBudget(v.req.kbps);
    const demux = createFlvDemuxer((au) => {
      if (gen !== v.gen || ws.readyState !== 1) return;
      produced += 1;
      if (!v.active) {
        v.active = true;
        v.starting = false;
        sendJson(ws, { t: "videoState", on: true, codec: "h264", encoder: label, capture, w: out.w, h: out.h, mon: mon.id });
        log(`video: ${label} ${out.w}x${out.h} ${v.req.fps}fps ${v.req.kbps}kbps (monitor ${mon.id})`);
        try {
          onStart(ws, { capture, encoder: encoderLabel(encoder), label, w: out.w, h: out.h, mon: mon.id });
        } catch {
          // status only
        }
      }
      const ok = shouldSendAu(v, { key: au.key, buffered: ws.bufferedAmount, budget, hardCap });
      if (!ok) {
        onAu(ws, { sent: false, bytes: au.data.length, key: au.key });
        return;
      }
      let cur = { cx: 0, cy: 0 };
      try {
        cur = cursorFor(mon) || cur;
      } catch {
        // cursor is cosmetic
      }
      v.seq = (v.seq + 1) & 0xffff;
      const header = buildVideoHeader({ mon: mon.id, w: mon.w, h: mon.h, cx: cur.cx, cy: cur.cy, key: au.key, config: au.config, seq: v.seq });
      try {
        ws.send(Buffer.concat([header, au.data]));
      } catch {
        return;
      }
      onAu(ws, { sent: true, bytes: au.data.length, key: au.key });
    });
    child.stdout.on("data", (chunk) => {
      if (gen !== v.gen) return;
      try {
        demux.push(chunk);
      } catch (err) {
        stderr += `\n${err?.message || err}`;
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.once("error", (err) => {
      stderr += `\n${err?.message || err}`;
    });
    child.once("exit", (code) => {
      if (watchdog) clearTimeout(watchdog);
      if (gen !== v.gen) return; // replaced or stopped on purpose
      v.proc = null;
      v.sig = "";
      if (!desired(ws)) return deactivate(ws);
      const why = (ddaTimedOut ? `tidak ada frame dalam ${DDA_FIRST_FRAME_MS / 1000} detik` : "") || ffmpegReason(stderr) || `ffmpeg keluar (${code})`;
      if (!produced && capture === "ddagrab") {
        // Capture problem, not the encoder: same encoder on gdigrab.
        v.badCap.add("ddagrab");
        log(`video: ddagrab gagal (${why}), pindah ke gdigrab`);
        if (v.active) {
          v.active = false;
          sendJson(ws, { t: "videoState", on: false, codec: "h264", restarting: true });
        }
        start(ws).catch((err) => fail(ws, String(err?.message || err)));
        return;
      }
      if (!produced) {
        // Never got a frame out of this encoder: try the next one.
        v.badEnc.add(encoder);
        v.lastWhy = `${encoderLabel(encoder)}: ${why}`.slice(0, 160);
        log(`video: ${encoder} gagal (${why}), coba encoder lain`);
        if (v.active) {
          v.active = false;
          sendJson(ws, { t: "videoState", on: false, codec: "h264", restarting: true });
        }
        start(ws).catch((err) => fail(ws, String(err?.message || err)));
        return;
      }
      const now = Date.now();
      v.crashes = v.crashes.filter((t) => now - t < 30_000);
      v.crashes.push(now);
      if (v.crashes.length > 3 || now - startedAt < 1500) return fail(ws, `ffmpeg berhenti: ${why}`);
      log(`video: ffmpeg berhenti (${why}), mulai ulang`);
      setTimeout(() => {
        if (gen === v.gen && desired(ws)) start(ws).catch((err) => fail(ws, String(err?.message || err)));
      }, 400);
    });
  }

  /** Re-evaluate one phone: start, restart (monitor/params changed) or stop. */
  function sync(ws) {
    const v = ws.video;
    if (!v) return;
    if (!desired(ws)) {
      if (v.proc || v.active || v.starting) deactivate(ws);
      return;
    }
    let mon = null;
    try {
      mon = monitorFor(ws);
    } catch {
      mon = null;
    }
    if (mon && (v.proc || v.starting) && v.sig === sigFor(ws, mon)) return;
    if (v.starting && !v.proc) return; // probing encoders; start() re-reads the monitor
    start(ws).catch((err) => fail(ws, String(err?.message || err)));
  }

  return {
    /** {t:"video"} from the phone. */
    request(ws, msg = {}) {
      const v = vs(ws);
      if (!msg.on) {
        v.want = false;
        v.gen += 1;
        killProc(v);
        v.active = false;
        v.starting = false;
        sendJson(ws, { t: "videoState", on: false, codec: "h264" });
        return;
      }
      v.want = true;
      v.req = videoRequest(msg);
      v.badEnc = new Set();
      v.badCap = new Set();
      v.crashes = [];
      v.lastWhy = "";
      if (!ws.wantsScreen || ws.wantsCam) {
        // Accepted; starts once the screen subscription is on.
        return;
      }
      sync(ws);
    },
    sync,
    /** True while JPEG must be skipped for this phone. */
    isActive(ws) {
      return Boolean(ws.video && ws.video.active && ws.video.want);
    },
    stop(ws) {
      if (!ws.video) return;
      ws.video.want = false;
      ws.video.gen += 1;
      killProc(ws.video);
      ws.video.active = false;
      ws.video.starting = false;
    },
  };
}
