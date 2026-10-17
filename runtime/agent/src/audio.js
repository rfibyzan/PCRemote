// PC sound -> phones that turned "Suara" on ({t:"audio", on}).
//
//   PCRemoteAudio.exe (WASAPI loopback, s16le) -> ffmpeg (Opus in Ogg)
//   -> createOggDepacketizer -> binary "PA" packets (audioproto.js)
//
// ONE capture + encoder for all listening phones; it runs only while at
// least one phone wants sound, so a phone that turns sound off really stops
// the PC sending it (data + battery). The helper is compiled on this PC with
// the .NET Framework csc.exe, like autostart's PCRemoteStart.exe.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCsc } from "./autostart.js";
import { findFfmpeg } from "./webcam.js";
import {
  audioHeader,
  audioKbps,
  createOggDepacketizer,
  ffmpegAudioArgs,
  parseFmtLine,
  pickOpusEncoder,
} from "./audioproto.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const audioDir = path.join(here, "..", "audio");
const SRC = path.join(audioDir, "PCRemoteAudio.cs");
const EXE = path.join(audioDir, "PCRemoteAudio.exe");
// A phone that cannot keep up gets packets dropped instead of a growing delay.
const MAX_BUFFERED = 128 * 1024;

function run(file, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), err });
    });
  });
}

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

let buildPromise = null;
/** Path to PCRemoteAudio.exe, (re)building it when the source is newer. */
export function ensureAudioHelper() {
  if (!buildPromise) {
    buildPromise = buildHelper().finally(() => {
      buildPromise = null;
    });
  }
  return buildPromise;
}

async function buildHelper() {
  const exeM = mtime(EXE);
  const srcM = mtime(SRC);
  if (exeM && exeM >= srcM) return { exe: EXE };
  const csc = findCsc();
  if (!csc) return exeM ? { exe: EXE } : { error: "csc.exe (.NET Framework 4) tidak ada di PC" };
  try {
    mkdirSync(audioDir, { recursive: true });
  } catch {
    // exists
  }
  const tmp = path.join(audioDir, `PCRemoteAudio.${process.pid}.tmp.exe`);
  const r = await run(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:x64", "/optimize+", "/r:System.dll", `/out:${tmp}`, SRC]);
  if (!r.ok || !existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing written
    }
    const why = (r.stdout + r.stderr).split(/\r?\n/).find((l) => /error/i.test(l)) || "kompilasi gagal";
    return exeM ? { exe: EXE } : { error: `helper suara: ${why.trim()}` };
  }
  try {
    if (existsSync(EXE)) unlinkSync(EXE);
    renameSync(tmp, EXE);
  } catch {
    // old exe still running (locked): keep it, try again next start
    return { exe: existsSync(EXE) ? EXE : tmp };
  }
  return { exe: EXE };
}

let encoderPromise = null;
function opusEncoder(bin) {
  if (!encoderPromise) {
    encoderPromise = run(bin, ["-hide_banner", "-encoders"], 15000).then((r) => pickOpusEncoder(r.stdout));
  }
  return encoderPromise;
}

export function createAudioManager({ log = () => {}, onState = () => {} } = {}) {
  const listeners = new Set(); // ws with wantsAudio
  let cur = null; // { gen, helper, ffmpeg, kbps }
  let gen = 0;
  let seq = 0;
  let crashes = [];
  let lastErr = "";

  function links() {
    return [...listeners].map((ws) => ws.peer?.link || "wifi");
  }

  function tell(ws, extra = {}) {
    onState(ws, { on: listeners.has(ws), running: Boolean(cur), ...extra });
  }

  function broadcast(pkt) {
    const frame = Buffer.concat([audioHeader(seq++), pkt]);
    for (const ws of listeners) {
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount > MAX_BUFFERED) continue;
      try {
        ws.send(frame);
      } catch {
        // socket closing
      }
    }
  }

  function kill() {
    const c = cur;
    cur = null;
    gen += 1;
    if (!c) return;
    for (const p of [c.helper, c.ffmpeg]) {
      if (!p) continue;
      try {
        p.stdin?.destroy();
      } catch {
        // ignore
      }
      try {
        p.kill();
      } catch {
        // already gone
      }
    }
  }

  function fail(msg) {
    lastErr = msg;
    log(`audio: ${msg}`);
    kill();
    for (const ws of [...listeners]) tell(ws, { error: msg });
  }

  async function start() {
    kill();
    const my = gen;
    const bin = findFfmpeg();
    if (!bin) return fail("ffmpeg tidak ditemukan di PC");
    const [helper, encoder] = await Promise.all([ensureAudioHelper(), opusEncoder(bin)]);
    if (my !== gen || !listeners.size) return;
    if (helper.error) return fail(helper.error);
    if (!encoder) return fail("ffmpeg PC ini tidak punya encoder Opus");
    const kbps = audioKbps(links());
    const c = { gen: my, kbps, helper: null, ffmpeg: null };
    cur = c;
    let hp;
    try {
      hp = spawn(helper.exe, [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return fail(`helper suara gagal jalan: ${e?.message || e}`);
    }
    c.helper = hp;
    let errText = "";
    let started = false;
    const startedAt = Date.now();
    hp.stderr.setEncoding("utf8");
    hp.stderr.on("data", (txt) => {
      for (const line of String(txt).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rate = parseFmtLine(line);
        if (rate && !started && cur === c) {
          started = true;
          startEncoder(c, bin, encoder, rate, kbps);
        } else if (!rate) {
          errText = line.trim();
        }
      }
    });
    hp.on("error", (e) => {
      if (cur === c) fail(`helper suara: ${e?.message || e}`);
    });
    hp.on("exit", (code) => {
      if (cur !== c) return;
      kill();
      if (!listeners.size) return;
      if (code === 3) {
        log("audio: output device berubah, mulai ulang capture");
        setTimeout(() => listeners.size && !cur && start(), 300);
        return;
      }
      const now = Date.now();
      crashes = crashes.filter((t) => now - t < 60000);
      crashes.push(now);
      const why = errText || `keluar (${code})`;
      if (crashes.length > 3 || now - startedAt < 1500) return fail(`capture suara berhenti: ${why}`);
      log(`audio: capture berhenti (${why}), mulai ulang`);
      setTimeout(() => listeners.size && !cur && start(), 1000);
    });
  }

  function startEncoder(c, bin, encoder, rate, kbps) {
    let ff;
    try {
      ff = spawn(bin, ffmpegAudioArgs({ rate, kbps, encoder }), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return fail(`ffmpeg suara gagal jalan: ${e?.message || e}`);
    }
    c.ffmpeg = ff;
    let ffErr = "";
    ff.stderr.setEncoding("utf8");
    ff.stderr.on("data", (t) => {
      ffErr = (ffErr + t).slice(-400);
    });
    const depack = createOggDepacketizer((pkt) => {
      if (cur === c) broadcast(pkt);
    });
    ff.stdout.on("data", (chunk) => depack(chunk));
    ff.stdin.on("error", () => {});
    c.helper.stdout.on("error", () => {});
    c.helper.stdout.pipe(ff.stdin);
    ff.on("exit", (code) => {
      if (cur !== c) return;
      fail(`ffmpeg suara berhenti (${code}): ${ffErr.trim().split(/\r?\n/).pop() || ""}`.trim());
    });
    lastErr = "";
    log(`audio: jalan (${rate} Hz -> Opus ${kbps} kbps, ${encoder}, ${listeners.size} HP)`);
    for (const ws of listeners) tell(ws);
  }

  /** Apply ws.wantsAudio (phone toggle) and re-tune for its link. */
  function sync(ws) {
    if (ws.wantsAudio) listeners.add(ws);
    else listeners.delete(ws);
    if (!listeners.size) {
      if (cur) log("audio: tidak ada HP yang mendengar, berhenti");
      kill();
      crashes = [];
      tell(ws);
      return;
    }
    if (!cur || cur.kbps !== audioKbps(links())) {
      crashes = [];
      start();
    }
    tell(ws, lastErr && !cur ? { error: lastErr } : {});
  }

  function stop(ws) {
    if (!listeners.has(ws)) return;
    ws.wantsAudio = false;
    listeners.delete(ws);
    if (!listeners.size) kill();
    else if (cur && cur.kbps !== audioKbps(links())) start();
  }

  function stopAll() {
    listeners.clear();
    kill();
  }

  return { sync, stop, stopAll, status: () => ({ running: Boolean(cur), listeners: listeners.size, error: lastErr }) };
}
