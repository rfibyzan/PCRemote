import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CAM_QUALITY = {
  lite: { width: 320, qv: 10, fps: 5 },
  low: { width: 480, qv: 8, fps: 8 },
  med: { width: 480, qv: 8, fps: 8 },
  high: { width: 960, qv: 5, fps: 6 },
  super: { width: 640, qv: 6, fps: 15 },
};

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");

let ffmpegPath = "";
let proc = null;
let latest = null;
let currentKey = "";
let currentName = "";

export function parseDshowList(text) {
  const devices = [];
  let section = "";
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/video devices/i.test(line) && !/audio devices/i.test(line)) {
      section = "video";
      continue;
    }
    if (/audio devices/i.test(line)) {
      section = "audio";
      current = null;
      continue;
    }
    const tagged = line.match(/"([^"]+)"\s*\((video|audio)\)/i);
    if (tagged) {
      if (tagged[2].toLowerCase() === "video") {
        current = { name: tagged[1], alt: "" };
        devices.push(current);
      } else current = null;
      continue;
    }
    const named = line.match(/^"([^"]+)"$/);
    if (named && section === "video") {
      current = { name: named[1], alt: "" };
      devices.push(current);
      continue;
    }
    const alt = line.match(/Alternative name\s+"([^"]+)"/i);
    if (alt && current) current.alt = alt[1];
  }
  return devices;
}

export function cameraScore(cam) {
  const n = `${cam?.name || ""} ${cam?.alt || ""}`.toLowerCase();
  let s = 0;
  if (/webcam|usb.?cam|logitech|c920|c270|c922|life.?cam|hd.?cam/.test(n)) s += 12;
  if (/integrated|built-?in|laptop|front/.test(n)) s += 8;
  if (/camera|webcam/.test(n)) s += 4;
  if (/\bir\b|infrared|winmojis|metadata|virtual|obs|snap camera|manycam|droidcam|nvidia broadcast/.test(n)) s -= 25;
  return s;
}

export function rankCameras(list) {
  return [...(list || [])].sort((a, b) => cameraScore(b) - cameraScore(a));
}

export function captureIds(cam) {
  const out = [];
  if (cam?.alt) out.push(cam.alt);
  if (cam?.name && cam.name !== cam.alt) out.push(cam.name);
  return out;
}

export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return { w: 0, h: 0 };
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return { w: 0, h: 0 };
}

function walkFor(dir, name, depth = 0, out = []) {
  if (depth > 5 || out.length) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) {
      out.push(full);
      return out;
    }
    if (entry.isDirectory()) walkFor(full, name, depth + 1, out);
    if (out.length) return out;
  }
  return out;
}

function isExeFile(candidate) {
  try {
    return Boolean(candidate) && existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findFfmpeg() {
  if (ffmpegPath && existsSync(ffmpegPath)) return ffmpegPath;
  const names = ["ffmpeg.exe", "ffmpeg"];
  const dirs = [
    process.env.PCREMOTE_HOME,
    process.env.PCREMOTE_RUNTIME,
    process.cwd(),
    agentRoot,
    join(agentRoot, ".."),
    dirname(process.execPath),
    join(dirname(process.execPath), ".."),
  ].filter(Boolean);
  const guessed = [];
  if (process.env.FFMPEG_PATH) guessed.push(process.env.FFMPEG_PATH);
  for (const dir of dirs) {
    for (const name of names) guessed.push(join(dir, name));
  }
  try {
    const out = execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    guessed.push(
      ...String(out)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    // not on PATH
  }
  const local = process.env.LOCALAPPDATA;
  if (local) guessed.push(...walkFor(join(local, "Microsoft", "WinGet", "Packages"), "ffmpeg.exe"));
  guessed.push("C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe");
  ffmpegPath = guessed.find((p) => isExeFile(p)) || "";
  return ffmpegPath;
}

let cameraCache = { at: 0, list: [] };

export async function listCameras() {
  if (cameraCache.list.length && Date.now() - cameraCache.at < 60000) return cameraCache.list;
  const bin = findFfmpeg();
  if (!bin) throw new Error("ffmpeg is not installed on this PC");
  const text = await new Promise((resolve, reject) => {
    execFile(bin, ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 2_000_000,
    }, (err, stdout, stderr) => {
      const blob = `${stdout || ""}\n${stderr || ""}`;
      if (parseDshowList(blob).length) resolve(blob);
      else reject(err || new Error("No webcam found"));
    });
  });
  const devices = parseDshowList(text);
  if (!devices.length) throw new Error("No webcam found");
  cameraCache = { at: Date.now(), list: devices };
  return devices;
}

function makeMjpegParser() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 8_000_000) buf = buf.subarray(buf.length - 2_000_000);
    const frames = [];
    let start = buf.indexOf(Buffer.from([0xff, 0xd8]));
    while (start >= 0) {
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) break;
      frames.push(Buffer.from(buf.subarray(start, end + 2)));
      buf = buf.subarray(end + 2);
      start = buf.indexOf(Buffer.from([0xff, 0xd8]));
    }
    return frames;
  };
}

function spawnCapture(deviceName, q, extraArgs) {
  const bin = findFfmpeg();
  return spawn(
    bin,
    [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-f",
      "dshow",
      "-rtbufsize",
      "32M",
      "-thread_queue_size",
      "64",
      ...extraArgs,
      "-i",
      `video=${deviceName}`,
      "-an",
      "-vf",
      `scale=${q.width}:-2`,
      "-r",
      String(q.fps),
      "-q:v",
      String(q.qv),
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function takeFrame(jpeg) {
  const size = jpegSize(jpeg);
  latest = { jpeg, w: size.w || latest?.w || 0, h: size.h || latest?.h || 0 };
  return latest;
}

export function webcamStatus() {
  return {
    running: Boolean(proc && !proc.killed),
    name: currentName,
    w: latest?.w || 0,
    h: latest?.h || 0,
  };
}

export function latestCamFrame() {
  return latest;
}

export async function stopWebcam() {
  currentKey = "";
  latest = null;
  const child = proc;
  proc = null;
  if (!child) return;
  try {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
    child.kill();
  } catch {
    // already gone
  }
}

function waitForFrame(child, timeoutMs = 7000) {
  const eat = makeMjpegParser();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Webcam started but sent no picture")), timeoutMs);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    }
    child.stdout.on("data", (chunk) => {
      const frames = eat(chunk);
      if (!frames.length) return;
      const next = takeFrame(frames[frames.length - 1]);
      if (!settled) finish(null, next);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (!settled && text && /error|fail|busy|cannot|not found|invalid|unsupported/i.test(text)) {
        finish(new Error(text.split(/\r?\n/).pop()));
      }
    });
    child.once("exit", (code) => {
      if (!settled) finish(new Error(code ? `Webcam exited (${code})` : "Webcam closed"));
      else if (proc === child) {
        proc = null;
        currentKey = "";
      }
    });
    child.once("error", (err) => finish(err));
  });
}

export function applyCamTune(base, tune = {}) {
  const qs = Math.max(-5, Math.min(8, Math.round(Number(tune.qStep) || 0)));
  const fs = Math.max(-5, Math.min(10, Math.round(Number(tune.fpsStep) || 0)));
  return {
    width: Math.max(240, Math.min(1920, Math.round(base.width))),
    qv: Math.max(2, Math.min(14, Math.round((base.qv ?? 8) - qs * 2))),
    fps: Math.max(3, Math.min(30, Math.round(base.fps + fs * 4))),
  };
}

export async function ensureWebcam(qualityKey = "low", tune = {}) {
  const key = qualityKey === "super" || qualityKey === "high" ? "high" : qualityKey === "lite" ? "lite" : "low";
  const q = applyCamTune(CAM_QUALITY[key] || CAM_QUALITY.low, tune);
  const sig = `${key}:${q.width}:${q.qv}:${q.fps}`;
  if (proc && currentKey === sig && latest) return latest;
  await stopWebcam();
  if (!findFfmpeg()) throw new Error("ffmpeg is not installed on this PC");
  const cams = rankCameras(await listCameras());
  const tries = [
    ["-video_size", "640x480", "-framerate", "15"],
    ["-video_size", "1280x720", "-framerate", "15"],
    ["-framerate", "15"],
    ["-vcodec", "mjpeg"],
    [],
  ];
  let lastErr = new Error("Could not start webcam");
  for (const cam of cams) {
    for (const id of captureIds(cam)) {
      for (const extra of tries) {
        const child = spawnCapture(id, q, extra);
        try {
          const frame = await waitForFrame(child, 7000);
          proc = child;
          currentKey = sig;
          currentName = cam.name || id;
          return frame;
        } catch (err) {
          lastErr = err;
          try {
            child.kill();
          } catch {
            // ignore
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }
  }
  throw lastErr;
}
