import { spawn } from "node:child_process";
import http from "node:http";
import { WebSocketServer } from "ws";
import { lanAddresses } from "./lan.js";
import { encryptJson, keyFromCode, normalizeCode, NTFY_HOSTS, NTFY_PREFIX, roomId } from "./crypto.js";
import { DEFAULT_PORT, displayCode, findExistingAgent, listenOnFreePort, loadLock, revokeLock } from "./lock.js";
import {
  beginDragOnMonitor,
  click,
  endDragOnMonitor,
  getClipboard,
  keyCombo,
  keyDown,
  keyTap,
  keyUp,
  lockWorkstation,
  media,
  moveAbsOnMonitor,
  moveDragOnMonitor,
  moveMouse,
  openTarget,
  screenSize,
  scroll,
  scrollH,
  setClipboard,
  tapAbsOnMonitor,
  typeText,
} from "./input.js";
import { QUALITY, captureMonitor, cursorOnMonitor, encodeProfile, frameFingerprint, listMonitors } from "./monitors.js";
import { hideConsole, startTray, claimSingleInstance } from "./tray.js";
import { superviseTunnel } from "./tunnel.js";
import { probeTunnel, wokeFromSleep } from "./keepalive.js";
import { ensureWebcam, latestCamFrame, stopWebcam, webcamStatus } from "./webcam.js";
import { createGamepadSession } from "./gamepad.js";
import { assertCredits, creditByline, creditChannel, creditSupport, creditsIntact } from "./credits.js";

// Optional QR on the dashboard (`npm install` pulls "qrcode"). Without it the
// page still works and simply shows the code.
let QRCode = null;
try {
  QRCode = (await import("qrcode")).default;
} catch {
  QRCode = null;
}
const qrCache = { text: "", svg: "" };

/** What the phone's QR scanner reads: lock code + LAN hosts (ip:port). The
 * code is already printed on the same page; the hosts just skip discovery. */
function pairUri() {
  const hosts = state.lan.map((ip) => `${ip}:${state.port}`).join(",");
  return `pcremote://pair?c=${encodeURIComponent(state.code)}${hosts ? `&h=${encodeURIComponent(hosts)}` : ""}`;
}

async function pairQrSvg() {
  if (!QRCode || !state.code) return "";
  const text = pairUri();
  if (qrCache.text === text) return qrCache.svg;
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b1220", light: "#ffffff" } });
    qrCache.text = text;
    qrCache.svg = svg;
    return svg;
  } catch {
    return "";
  }
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const state = {
  code: "",
  key: null,
  room: "",
  lan: [],
  tunnel: "",
  port: DEFAULT_PORT,
  lastAnnounceSig: "",
  lastAnnounceAt: 0,
  name: "PC",
  clients: new Set(),
};

function publicMonitors() {
  return listMonitors().map(({ id, w, h, primary }, index) => ({
    id,
    name: primary ? "Main screen" : `Screen ${index + 1}`,
    w,
    h,
    primary,
  }));
}

function publicErr(err) {
  const raw = String(err?.message || err || "");
  if (/ffmpeg|dshow|device|webcam/i.test(raw)) return "Webcam is not available";
  const cleaned = raw
    .replace(/wss?:\/\/\S+/gi, "")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "")
    .trim();
  return cleaned || "Something went wrong";
}

function openWindowsFirewall(port) {
  if (process.platform !== "win32") return;
  const exe = process.execPath;
  const runs = [
    ["advfirewall", "firewall", "add", "rule", "name=PC Remote", "dir=in", "action=allow", `program=${exe}`, "enable=yes", "profile=any"],
    ["advfirewall", "firewall", "add", "rule", "name=PC Remote Port", "dir=in", "action=allow", "protocol=TCP", `localport=${port}`, "enable=yes", "profile=any"],
  ];
  for (const args of runs) {
    try {
      const child = spawn("netsh", args, { windowsHide: true, stdio: "ignore" });
      if (typeof child.unref === "function") child.unref();
    } catch {
      // first listen still triggers a Windows prompt on many PCs
    }
  }
}

function usbReverse(port) {
  try {
    const child = spawn("adb", ["reverse", `tcp:${port}`, `tcp:${port}`], { windowsHide: true, stdio: "ignore" });
    if (typeof child.unref === "function") child.unref();
  } catch {
    // phone USB debugging is optional
  }
}

function monitorFor(ws) {
  const mons = listMonitors();
  if (ws.view === "all") {
    return {
      id: "all",
      left: Math.min(...mons.map((m) => m.left)),
      top: Math.min(...mons.map((m) => m.top)),
      right: Math.max(...mons.map((m) => m.right)),
      bottom: Math.max(...mons.map((m) => m.bottom)),
      w: Math.max(...mons.map((m) => m.right)) - Math.min(...mons.map((m) => m.left)),
      h: Math.max(...mons.map((m) => m.bottom)) - Math.min(...mons.map((m) => m.top)),
    };
  }
  return mons[ws.monitorId] || mons.find((m) => m.primary) || mons[0];
}

function clientTune(ws) {
  return {
    qStep: Number(ws?.qStep) || 0,
    fpsStep: Number(ws?.fpsStep) || 0,
    width: Number(ws?.encWidth) || 0,
    jpeg: Number(ws?.encJpeg) || 0,
    fps: Number(ws?.encFps) || 0,
    viewPx: Number(ws?.encViewPx) || 0,
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendFrame(ws, jpeg, meta) {
  if (ws.readyState !== 1) return;
  const crop = meta.crop || { x: 0, y: 0, w: 1, h: 1 };
  const header = Buffer.alloc(16);
  header[0] = 0x50;
  header[1] = 0x52;
  header[2] = meta.mon === "all" ? 1 : meta.mon === "cam" ? 2 : 0;
  header[3] = typeof meta.mon === "number" ? meta.mon : 0;
  header.writeUInt16LE(meta.w || 0, 4);
  header.writeUInt16LE(meta.h || 0, 6);
  header.writeUInt16LE(Math.max(0, Math.min(10000, Math.round((meta.cx || 0) * 10000))), 8);
  header.writeUInt16LE(Math.max(0, Math.min(10000, Math.round((meta.cy || 0) * 10000))), 10);
  header[12] = Math.max(0, Math.min(255, Math.round((crop.x || 0) * 255)));
  header[13] = Math.max(0, Math.min(255, Math.round((crop.y || 0) * 255)));
  header[14] = Math.max(0, Math.min(255, Math.round((crop.w || 1) * 255)));
  header[15] = Math.max(0, Math.min(255, Math.round((crop.h || 1) * 255)));
  ws.send(Buffer.concat([header, jpeg]));
}

function sendQualityAck(ws) {
  try {
    const crop = ws.crop || { x: 0, y: 0, w: 1, h: 1 };
    const cropped = Boolean(crop && (crop.w < 0.995 || crop.h < 0.995 || crop.x > 0.004 || crop.y > 0.004));
    const remote = ws.link === "remote";
    const q = encodeProfile(ws.quality || "low", remote, cropped, clientTune(ws));
    send(ws, {
      t: "qualityAck",
      effective: { width: q.width, quality: q.quality, fps: q.fps },
      link: ws.link || "wifi",
      cropped,
      quality: ws.quality,
    });
  } catch {
    // ack is best-effort
  }
}

function helloPayload() {
  const size = screenSize();
  return {
    t: "hello",
    name: state.name,
    screen: size,
    monitors: publicMonitors(),
    mode: "direct",
  };
}

/**
 * GAME (existing "Game" mode entry) helpers. Additive only: PAD / Q / TYPE /
 * WEBCAM / WIN paths never call these. Each phone connection owns at most one
 * gamepad session, torn down on gamepadEnd or socket close so re-entering
 * GAME never duplicates it.
 */
async function handleGamepad(ws, msg) {
  if (!ws.gameSession) ws.gameSession = createGamepadSession();
  const res = await ws.gameSession.update(msg.state);
  if (res.ok) {
    ws.gamepadErrSent = "";
    if (!ws.gamepadOn) {
      ws.gamepadOn = true;
      send(ws, { t: "gamepad", on: true });
    }
    return;
  }
  ws.gamepadOn = false;
  const err = res.error || "ViGEmBus unavailable";
  if (ws.gamepadErrSent !== err) {
    ws.gamepadErrSent = err;
    send(ws, { t: "gamepad", on: false, error: err });
  }
}

async function endGamepad(ws) {
  ws.gamepadOn = false;
  ws.gamepadErrSent = "";
  const session = ws.gameSession;
  ws.gameSession = null;
  if (session) {
    try {
      await session.close();
    } catch {
      // teardown is best-effort
    }
  }
  send(ws, { t: "gamepad", on: false });
}

const ORDERED_INPUT = new Set(["move", "click", "scroll", "abs", "drag", "key", "combo", "text", "media"]);

async function handleCommand(ws, msg) {
  const mon = monitorFor(ws);
  switch (msg.t) {
    case "move":
      moveMouse(msg.dx, msg.dy);
      break;
    case "click":
      click(msg.btn || "left", msg.down !== false, msg.up !== false);
      break;
    case "scroll":
      if (msg.dx) scrollH(msg.dx);
      if (msg.dy) scroll(msg.dy);
      break;
    case "abs":
      if (msg.click) await tapAbsOnMonitor(mon, msg.x, msg.y, msg.click);
      else moveAbsOnMonitor(mon, msg.x, msg.y);
      break;
    case "drag":
      if (msg.phase === "start") {
        await beginDragOnMonitor(mon, msg.x, msg.y, msg.btn || "left");
      } else if (msg.phase === "move") {
        moveDragOnMonitor(mon, msg.x, msg.y);
      } else if (msg.phase === "end") {
        await endDragOnMonitor(mon, msg.x, msg.y, msg.btn || "left");
      }
      break;
    case "key":
      // Hold = down only, release = up only. Anything else is a one-shot tap.
      // Never treat a release as a tap (that typed the key again on finger-up).
      if (msg.down === true && msg.up !== true) keyDown(msg.key);
      else if (msg.up === true) keyUp(msg.key);
      else await keyTap(msg.key);
      break;
    case "combo":
      await keyCombo(Array.isArray(msg.keys) ? msg.keys : [], { hold: Boolean(msg.hold), release: Boolean(msg.release) });
      break;
    case "text":
      typeText(msg.s);
      break;
    case "media":
      media(msg.a);
      break;
    case "lock":
      lockWorkstation();
      break;
    case "open":
      openTarget(msg.target || msg.url);
      break;
    case "monitor":
      if (msg.id === "all") ws.view = "all";
      else {
        ws.view = "one";
        ws.monitorId = Number(msg.id) || 0;
      }
      ws.lastFp = "";
      send(ws, { t: "monitors", monitors: publicMonitors(), current: ws.view === "all" ? "all" : ws.monitorId });
      sendQualityAck(ws);
      break;
    case "quality":
      ws.quality = QUALITY[msg.q] ? msg.q : "low";
      ws.qStep = Math.max(-5, Math.min(8, Math.round(Number(msg.qStep) || 0)));
      ws.fpsStep = Math.max(-5, Math.min(10, Math.round(Number(msg.fpsStep) || 0)));
      ws.encWidth = Math.max(0, Math.min(1920, Math.round(Number(msg.width) || 0)));
      ws.encJpeg = Math.max(0, Math.min(92, Math.round(Number(msg.jpeg) || 0)));
      ws.encFps = Math.max(0, Math.min(30, Math.round(Number(msg.fps) || 0)));
      ws.encViewPx = Math.max(0, Math.min(2560, Math.round(Number(msg.viewPx) || 0)));
      ws.encTick = (Number(ws.encTick) || 0) + 1;
      ws.lastFp = "";
      if (msg.link === "remote" || msg.link === "wifi" || msg.link === "usb") ws.link = msg.link;
      sendQualityAck(ws);
      if (ws.wantsCam) {
        ensureWebcam(ws.quality, clientTune(ws)).catch((err) => send(ws, { t: "cam", on: false, error: publicErr(err) }));
      }
      break;
    case "crop":
      ws.crop = {
        x: Math.max(0, Math.min(1, Number(msg.x) || 0)),
        y: Math.max(0, Math.min(1, Number(msg.y) || 0)),
        w: Math.max(0.02, Math.min(1, Number(msg.w) || 1)),
        h: Math.max(0.02, Math.min(1, Number(msg.h) || 1)),
      };
      ws.lastFp = "";
      sendQualityAck(ws);
      break;
    case "cam":
      if (msg.on) {
        try {
          const frame = await ensureWebcam(ws.quality || "low", clientTune(ws));
          ws.wantsCam = true;
          ws.wantsScreen = false;
          send(ws, { t: "cam", on: true, w: frame.w, h: frame.h });
        } catch (err) {
          ws.wantsCam = false;
          send(ws, { t: "cam", on: false, error: publicErr(err) });
        }
      } else {
        ws.wantsCam = false;
        if (![...state.clients].some((c) => c.wantsCam)) await stopWebcam();
        send(ws, { t: "cam", on: false });
      }
      break;
    case "ping":
      send(ws, { t: "pong", ts: Date.now() });
      break;
    case "gamepad":
      await handleGamepad(ws, msg);
      break;
    case "gamepadEnd":
      await endGamepad(ws);
      break;
    case "clipboard":
      if (msg.s != null) await setClipboard(msg.s);
      send(ws, { t: "clipboard", s: await getClipboard() });
      break;
    default:
      break;
  }
}

function dashboard(qrSvg = "") {
  assertCredits("dashboard");
  const mons = publicMonitors();
  const shown = displayCode(state.code);
  const lanOk = state.lan.length > 0;
  const netOk = Boolean(state.tunnel);
  const by = creditByline();
  const support = creditSupport();
  const pill = (label, ok, okText, waitText) =>
    `<div class="pill"><span class="dot ${ok ? "on" : ""}"></span><span class="k">${label}</span><span class="${ok ? "ok" : "muted"}">${ok ? okText : waitText}</span></div>`;
  const qrBlock = qrSvg
    ? `<div class="qr">${qrSvg}</div><p class="qrcap">Scan with the PC Remote app<br><span class="muted">(Scan QR on the connect screen)</span></p>`
    : `<div class="qr qr-off"><span>QR unavailable<br><small>run <code>npm install</code> in runtime\\agent</small></span></div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PC Remote</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin:0; min-height:100%; background:#0b1220; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color:#e8eefc; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:820px; background:#151d2e; border:1px solid #1e293b; border-radius:20px; padding:28px 32px; box-shadow:0 20px 60px rgba(0,0,0,.35); }
  .head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
  h1 { margin:0; font-size:26px; }
  .phones { background:#0c4a6e; color:#7dd3fc; border-radius:999px; padding:5px 12px; font-size:13px; font-weight:700; }
  .grid { display:flex; gap:32px; align-items:center; flex-wrap:wrap; }
  .left { flex:1 1 320px; min-width:0; }
  .right { flex:0 0 220px; text-align:center; margin:0 auto; }
  .label { color:#94a3b8; font-size:13px; margin:0 0 6px; }
  .code { font-family: Consolas, "Cascadia Mono", monospace; font-size:44px; letter-spacing:6px; font-weight:700; color:#7dd3fc; margin:0 0 6px; white-space:nowrap; }
  .sub { color:#94a3b8; font-size:13px; margin:0 0 20px; }
  .pills { display:flex; flex-direction:column; gap:8px; margin-bottom:22px; }
  .pill { display:flex; align-items:center; gap:10px; background:#0f172a; border-radius:10px; padding:9px 12px; font-size:14px; }
  .pill .k { color:#cbd5e1; flex:1; }
  .dot { width:9px; height:9px; border-radius:50%; background:#f59e0b; }
  .dot.on { background:#22c55e; }
  .ok { color:#4ade80; font-weight:600; }
  .muted { color:#94a3b8; }
  .qr { width:220px; height:220px; background:#fff; border-radius:14px; padding:10px; margin:0 auto; }
  .qr svg { width:100%; height:100%; display:block; }
  .qr-off { display:flex; align-items:center; justify-content:center; background:#0f172a; color:#94a3b8; font-size:13px; text-align:center; border:1px dashed #334155; }
  .qrcap { font-size:13px; margin:10px 0 0; color:#cbd5e1; }
  .danger { display:flex; align-items:center; gap:12px; flex-wrap:wrap; border-top:1px solid #1e293b; padding-top:16px; }
  button { background:#1e293b; color:#e8eefc; border:1px solid #334155; border-radius:10px; padding:9px 14px; font-weight:700; cursor:pointer; }
  button:hover { background:#7f1d1d; border-color:#ef4444; }
  .small { color:#64748b; font-size:12px; }
  .credit { margin:18px 0 0; color:#64748b; font-size:12px; }
  .credit a { color:#7dd3fc; text-decoration:none; }
  code { color:#cbd5e1; }
</style></head>
<body><div class="card">
  <div class="head"><h1>PC Remote</h1><span class="phones">${state.clients.size} phone${state.clients.size === 1 ? "" : "s"} connected</span></div>
  <div class="grid">
    <div class="left">
      <p class="label">Pair code</p>
      <p class="code">${escapeHtml(shown)}</p>
      <p class="sub">Enter it on the phone <b>once</b>, or scan the QR. It stays the same after restarts.</p>
      <div class="pills">
        ${pill("Local Wi‑Fi", lanOk, "ready", "no network yet")}
        ${pill("Internet", netOk, "ready", "starting…")}
        ${pill("Screens", mons.length > 0, String(mons.length), "0")}
      </div>
    </div>
    <div class="right">${qrBlock}</div>
  </div>
  <div class="danger">
    <form method="POST" action="/revoke" onsubmit="return confirm('Phones will need this new code. Continue?')">
      <button type="submit">Make a new lock code</button>
    </form>
    <span class="small">Only do that if you want to kick every paired phone.</span>
  </div>
  <p class="credit"><a href="${creditChannel()}" target="_blank" rel="noopener">${by}</a> · ${support}</p>
</div></body></html>`;
}

async function publishAnnounce(force = false) {
  const body = {
    name: state.name,
    lan: state.lan.map((ip) => `${ip}:${state.port}`),
    tunnel: state.tunnel,
    port: state.port,
    ts: Date.now(),
  };
  // Include the lock room so a new pair code always publishes, even when the
  // LAN / tunnel addresses are unchanged. Without that, revoke looked like a
  // no-op for up to 8 minutes and phones could not find the PC until restart.
  const sig = `${state.room}|${body.lan.join(",")}|${body.tunnel}|${body.port}`;
  if (!force && sig === state.lastAnnounceSig && Date.now() - (state.lastAnnounceAt || 0) < 8 * 60 * 1000) {
    return;
  }
  const payload = encryptJson(body, state.key);
  const topic = `${NTFY_PREFIX}${state.room}`;
  const results = await Promise.all(
    NTFY_HOSTS.map(async (host) => {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 4000);
        const res = await fetch(`${host}/${topic}`, {
          method: "POST",
          headers: { Title: "announce", Priority: "min" },
          body: payload,
          signal: ac.signal,
        });
        clearTimeout(timer);
        return res.ok;
      } catch {
        return false;
      }
    }),
  );
  if (results.some(Boolean)) {
    state.lastAnnounceSig = sig;
    state.lastAnnounceAt = Date.now();
  } else {
    console.warn("announce failed on every board");
  }
}

function kickAllClients(reason = "lock changed") {
  for (const ws of [...state.clients]) {
    try {
      send(ws, { t: "error", m: reason });
    } catch {
      // closing anyway
    }
    try {
      ws.close();
    } catch {
      // already gone
    }
  }
  state.clients.clear();
}

// Keep the socket queue under about two frames. Anything deeper just shows a
// stale picture long after the user has moved on. The floor is per link; the
// ceiling follows the real frame size, because a fixed 40 KB gate with 50 KB
// frames allowed zero frames in flight and capped the stream at one frame
// per network round trip.
function sendBudget(ws) {
  const floor = ws.link === "remote" ? 40_000 : 80_000;
  return Math.max(floor, Math.round((Number(ws.lastFrameBytes) || 0) * 1.6));
}

// Per-socket stream diagnostics, pushed every ~2 s as {t:"streamStats"} so
// the phone can show WHERE frames go missing: not captured in time (PC),
// held back by a full socket (network), or skipped because the screen did
// not change (static, by design). Old phones ignore the unknown message.
function noteStream(ws, field, n = 1) {
  if (!ws.st) ws.st = { since: Date.now(), sent: 0, same: 0, busy: 0, capMs: 0, caps: 0 };
  ws.st[field] += n;
}
function flushStreamStats(ws, now) {
  const st = ws.st;
  if (!st || now - st.since < 2000) return;
  const sec = (now - st.since) / 1000;
  send(ws, {
    t: "streamStats",
    sent: Math.round((st.sent / sec) * 10) / 10,
    same: Math.round((st.same / sec) * 10) / 10,
    busy: Math.round((st.busy / sec) * 10) / 10,
    capMs: st.caps ? Math.round(st.capMs / st.caps) : 0,
  });
  ws.st = { since: now, sent: 0, same: 0, busy: 0, capMs: 0, caps: 0 };
}

async function screenLoop() {
  let creditTick = 0;
  while (true) {
    if (++creditTick % 240 === 0) assertCredits("screen");
    const live = [...state.clients].filter((ws) => ws.readyState === 1);
    const camClients = live.filter((ws) => ws.wantsCam);
    const screenClients = live.filter((ws) => ws.wantsScreen && !ws.wantsCam);
    if (!camClients.length && !screenClients.length) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const started = Date.now();
    if (camClients.length) {
      const frame = latestCamFrame();
      if (frame?.jpeg) {
        for (const ws of camClients) {
          if (ws.bufferedAmount > sendBudget(ws)) continue;
          sendFrame(ws, frame.jpeg, { mon: "cam", w: frame.w, h: frame.h, cx: 0, cy: 0 });
        }
      }
    }
    const groups = new Map();
    for (const ws of screenClients) {
      const busy = ws.bufferedAmount > sendBudget(ws);
      if (busy && ws.lastFp) {
        noteStream(ws, "busy");
        continue;
      }
      const crop = { ...(ws.crop || { x: 0, y: 0, w: 1, h: 1 }) };
      const key = `${ws.view}:${ws.monitorId}:${ws.quality}:${ws.link}:${ws.encWidth || 0}:${ws.encJpeg || 0}:${ws.encViewPx || 0}:${ws.qStep || 0}:${ws.fpsStep || 0}:${crop.x.toFixed(3)}:${crop.y.toFixed(3)}:${crop.w.toFixed(3)}:${crop.h.toFixed(3)}`;
      const group = groups.get(key);
      if (group) group.clients.push(ws);
      else groups.set(key, { clients: [ws], crop, view: ws.view, quality: ws.quality, link: ws.link });
    }
    for (const group of groups.values()) {
      const ws = group.clients[0];
      const viewAtStart = group.view;
      const monitorAtStart = ws.monitorId;
      try {
        const mon = monitorFor(ws);
        const capStart = Date.now();
        const jpeg = await captureMonitor(mon, group.quality || "lite", viewAtStart === "all", group.link === "remote", group.crop, clientTune(ws));
        const capMs = Date.now() - capStart;
        for (const client of group.clients) {
          if (client.readyState !== 1 || client.wantsCam) continue;
          if (client.view !== viewAtStart || client.monitorId !== monitorAtStart) continue;
          const cursor = cursorOnMonitor(mon);
          const fp = `${client.quality}:${client.encWidth || 0}:${client.encJpeg || 0}:${client.encFps || 0}:${client.encViewPx || 0}:${client.qStep || 0}:${client.fpsStep || 0}:${client.encTick || 0}:${viewAtStart}:${monitorAtStart}:${group.crop.x.toFixed(3)}:${group.crop.y.toFixed(3)}:${group.crop.w.toFixed(3)}:${group.crop.h.toFixed(3)}:${frameFingerprint(jpeg)}`;
          noteStream(client, "capMs", capMs);
          noteStream(client, "caps");
          if (fp === client.lastFp) {
            noteStream(client, "same");
            send(client, { t: "cur", cx: cursor.cx, cy: cursor.cy });
            continue;
          }
          client.lastFp = fp;
          client.lastFrameBytes = jpeg.length;
          noteStream(client, "sent");
          sendFrame(client, jpeg, {
            mon: viewAtStart === "all" ? "all" : mon.id,
            w: mon.w,
            h: mon.h,
            cx: cursor.cx,
            cy: cursor.cy,
            crop: group.crop,
          });
        }
      } catch (err) {
        console.warn("screenshot failed:", err.message);
      }
    }
    const statNow = Date.now();
    for (const ws of screenClients) flushStreamStats(ws, statNow);
    const sample = camClients[0] || screenClients[0];
    const cropped = Boolean(sample?.crop && (sample.crop.w < 0.995 || sample.crop.h < 0.995));
    const q = encodeProfile(sample?.quality || "low", sample?.link === "remote", cropped, clientTune(sample));
    const wait = Math.max(8, Math.round(1000 / (q.fps || 5)) - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function runScreenLoop() {
  while (true) {
    try {
      await screenLoop();
    } catch (err) {
      console.warn("screen loop:", err?.message || err);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function attachClientKeepalive(wss) {
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 25000);
  if (typeof beat.unref === "function") beat.unref();
  wss.on("close", () => clearInterval(beat));
}

function printBanner() {
  console.log(
    [
      "==============================================",
      "  PC Remote agent is running",
      `  ${creditByline()}`,
      "  Pair code:    open the tray dashboard",
      `  Dashboard:    open the tray icon`,
      `  Local Wi-Fi:  ${state.lan.length ? "ready" : "no network yet"}`,
      `  Internet:     ${state.tunnel ? "ready" : "starting"}`,
      `  ${creditSupport()}`,
      "==============================================",
    ].join("\n"),
  );
}

function applyLock(lock) {
  state.code = lock.code;
  state.key = keyFromCode(state.code);
  state.room = roomId(state.code);
}

async function main() {
  assertCredits("startup");
  applyLock(loadLock());
  state.lan = lanAddresses();

  if (process.platform === "win32" && !claimSingleInstance()) {
    console.log("PC Remote is already running.");
    process.exit(0);
  }

  const already = await findExistingAgent();
  if (already) {
    console.log(`PC Remote is already running on port ${already.port}.`);
    process.exit(0);
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          name: state.name,
          port: state.port,
          lanReady: state.lan.length > 0,
          internet: Boolean(state.tunnel),
          monitors: publicMonitors(),
          camera: ((cam) => ({ running: cam.running, w: cam.w, h: cam.h }))(webcamStatus()),
          clients: state.clients.size,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/revoke") {
      applyLock(revokeLock());
      kickAllClients("New lock code — pair again on the phone");
      // Force a fresh announce into the new room so phones do not need a PC restart.
      void publishAnnounce(true);
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    void pairQrSvg().then((svg) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboard(svg));
    });
  });
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 60_000;
  server.on("connection", (sock) => {
    sock.setKeepAlive(true, 15_000);
    sock.setTimeout(0);
  });

  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  attachClientKeepalive(wss);
  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.authed = false;
    ws.wantsScreen = false;
    ws.monitorId = listMonitors().find((m) => m.primary)?.id || 0;
    ws.view = "one";
    ws.quality = "lite";
    ws.qStep = 0;
    ws.fpsStep = 0;
    ws.encViewPx = 0;
    ws.link = "wifi";
    ws.wantsCam = false;
    ws.crop = { x: 0, y: 0, w: 1, h: 1 };
    ws.on("message", async (raw) => {
      ws.isAlive = true;
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!ws.authed) {
        if (msg.t === "auth" && normalizeCode(msg.token) === state.code) {
          if (!creditsIntact()) {
            send(ws, { t: "error", m: "PC Remote credit seal broken" });
            ws.close();
            return;
          }
          ws.authed = true;
          state.clients.add(ws);
          send(ws, helloPayload());
          sendQualityAck(ws);
        } else {
          send(ws, { t: "error", m: "bad token" });
          ws.close();
        }
        return;
      }
      if (msg.t === "screen") {
        ws.wantsScreen = Boolean(msg.on);
        return;
      }
      // Input must reach Windows in the order it was sent. A tap now waits a
      // frame between move and click, so without this chain the next message
      // (a drag start, a key) would run in the middle of it.
      const run = () =>
        handleCommand(ws, msg).catch((err) => send(ws, { t: "error", m: publicErr(err) }));
      if (ORDERED_INPUT.has(msg.t)) {
        ws.inputChain = (ws.inputChain || Promise.resolve()).then(run);
        await ws.inputChain;
      } else {
        await run();
      }
    });
    ws.on("close", () => {
      state.clients.delete(ws);
      if (ws.gameSession) endGamepad(ws).catch(() => {});
      if (![...state.clients].some((c) => c.wantsCam)) stopWebcam();
    });
  });

  try {
    state.port = await listenOnFreePort(server, DEFAULT_PORT);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.log("PC Remote is already running.");
      process.exit(0);
    }
    throw err;
  }
  printBanner();
  openWindowsFirewall(state.port);
  usbReverse(state.port);

  if (process.platform === "win32") {
    if (process.env.PCREMOTE_TRAY === "1") hideConsole();
    if (process.env.PCREMOTE_LAUNCHER !== "1") {
      startTray({
        dashboard: `http://127.0.0.1:${state.port}/`,
        onExit: () => process.exit(0),
      });
    }
  }

  const tunnel = superviseTunnel(state.port, (url) => {
    const next = url || "";
    if (next === state.tunnel) return;
    state.tunnel = next;
    tunnelReadyAt = next ? Date.now() : 0;
    if (next) console.log("Internet: ready");
    else console.warn("Internet: down");
    state.lastAnnounceSig = "";
    publishAnnounce();
  });

  let lastBeat = Date.now();
  let tunnelFails = 0;
  let tunnelReadyAt = 0;
  const watchdog = setInterval(async () => {
    const now = Date.now();
    if (wokeFromSleep(lastBeat, now)) {
      console.warn("PC woke from sleep; restarting tunnel");
      tunnel.restart();
      tunnelFails = 0;
    }
    lastBeat = now;
    state.lan = lanAddresses();
    if (state.tunnel && Date.now() - tunnelReadyAt > 20_000) {
      const ok = await probeTunnel(state.tunnel);
      if (ok) tunnelFails = 0;
      else {
        tunnelFails += 1;
        if (tunnelFails >= 3) {
          console.warn("tunnel health check failed; restarting cloudflared");
          tunnelFails = 0;
          tunnel.restart();
        }
      }
    } else if (!state.tunnel && (!tunnel.running() || tunnel.hung())) {
      if (tunnel.hung()) console.warn("cloudflared produced no URL; restarting");
      tunnel.restart();
    }
    publishAnnounce();
  }, 30_000);
  if (typeof watchdog.unref === "function") watchdog.unref();

  process.on("uncaughtException", (err) => {
    console.error("uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection", err);
  });

  runScreenLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
