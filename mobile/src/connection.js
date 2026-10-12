/**
 * Single shared connection to the PC agent. All modes (Game/Pad/Q/Type/
 * Webcam/Win) share ONE WebSocket — switching modes only changes
 * subscriptions (screen on/off, quality, cam), never the socket.
 *
 * Stages (for detailed UI, not just "reconnecting"):
 * idle → checking-saved → polling-announce → probing-candidate →
 * ws-connecting → auth → connected | failed(reason)
 * Reconnects show attempt count + next delay + last error.
 */
import * as SecureStore from "expo-secure-store";
import React from "react";
import { AppState } from "react-native";
import { createConnLog, formatLog } from "./connlog";
import { getDeviceInfo } from "./deviceinfo";
import { newestAnnounce, parseRecent, removeRecent, upsertRecent } from "./recent";
import {
  DEFAULT_PORT,
  NTFY_HOSTS,
  NTFY_PREFIX,
  STORE_HOSTS,
  STORE_LOCK,
  decryptAnnounce,
  keyForCode,
  msg,
  normalizeCode,
  parseBinaryFrame,
  roomIdForCode,
} from "./protocol";

const listeners = new Set();
const STORE_RECENT = "pcremote.recent";

/** Every connect step, timestamped (see connlog.js). */
export const connLog = createConnLog(200);
function log(text, level = "info") {
  connLog.add(text, level);
}
const STATUS_LEVEL = { failed: "error", unreachable: "error", rejected: "error", blocked: "error", kicked: "warn", reconnecting: "warn", connected: "ok" };

function emit(event) {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch {
      // one bad listener must not break the socket loop
    }
  }
}

export function addListener(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const MAX_RETRIES = 10;

const state = {
  ws: null,
  url: "",
  code: "",
  hello: null,
  connected: false,
  status: "idle",
  detail: "",
  stage: "idle",
  link: "",
  lastError: "",
  attempts: 0,
  wantScreen: false,
  screenHandler: null,
  lastHosts: [],
  recent: [],
  device: null,
  kicked: false,
  _pingTimer: null,
  _pongTimer: null,
  _manualClose: false,
  _findGen: 0,
  _connectGen: 0,
  _lastPongAt: 0,
  _pongMiss: 0,
};

async function loadStore() {
  try {
    state.code = normalizeCode((await SecureStore.getItemAsync(STORE_LOCK)) || "");
  } catch {
    state.code = "";
  }
  try {
    state.lastHosts = JSON.parse((await SecureStore.getItemAsync(STORE_HOSTS)) || "[]");
    if (!Array.isArray(state.lastHosts)) state.lastHosts = [];
  } catch {
    state.lastHosts = [];
  }
  try {
    state.recent = parseRecent(await SecureStore.getItemAsync(STORE_RECENT));
  } catch {
    state.recent = [];
  }
  if (!state.device) {
    try {
      state.device = await getDeviceInfo();
    } catch {
      state.device = null;
    }
  }
}

async function saveRecent() {
  try {
    await SecureStore.setItemAsync(STORE_RECENT, JSON.stringify(state.recent));
  } catch {
    // best-effort
  }
  emit({ t: "recent", recent: [...state.recent] });
}

async function saveHosts() {
  try {
    await SecureStore.setItemAsync(STORE_HOSTS, JSON.stringify(state.lastHosts));
  } catch {
    // best-effort
  }
}

export function getRecent() {
  return [...state.recent];
}

/** Forget one PC from the recent list (and log out if it is the current one). */
export async function forgetRecent(code) {
  state.recent = removeRecent(state.recent, code);
  await saveRecent();
  if (code === state.code) await clearPairing();
}

/** Text for "Copy log": device + current status + every step. */
export function connLogText() {
  const d = state.device;
  const head = [
    `PCRemote log ${new Date().toISOString()}`,
    d ? `HP: ${d.name} (${d.os}, app ${d.app || "?"})` : "",
    `Status: ${state.status} · ${state.stage}${state.link ? ` · ${state.link}` : ""}${state.url ? ` · ${shortHost(state.url)}` : ""}`,
    state.lastError ? `Error terakhir: ${state.lastError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return formatLog(connLog.list(), head);
}

async function rememberHost(wsUrl) {
  const http = String(wsUrl).replace(/^ws/, "http");
  state.lastHosts = [http, ...state.lastHosts.filter((h) => h !== http)].slice(0, 6);
  try {
    await SecureStore.setItemAsync(STORE_HOSTS, JSON.stringify(state.lastHosts));
  } catch {
    // pairing memory is best-effort
  }
}

export async function setLockCode(code) {
  const next = normalizeCode(code);
  if (next && next !== state.code) {
    // Another PC: its own remembered hosts, never the previous PC's (those
    // answer /health fine and then reject the code).
    const known = state.recent.find((r) => r.code === next);
    state.lastHosts = known?.hosts ? [...known.hosts] : [];
    await saveHosts();
  }
  state.code = next;
  try {
    if (state.code) await SecureStore.setItemAsync(STORE_LOCK, state.code);
    else await SecureStore.deleteItemAsync(STORE_LOCK);
  } catch {
    // pairing memory is best-effort
  }
  emit({ t: "code", code: state.code });
}

export async function clearPairing() {
  try {
    await SecureStore.deleteItemAsync(STORE_LOCK);
  } catch {
    // ignore
  }
  try {
    await SecureStore.deleteItemAsync(STORE_HOSTS);
  } catch {
    // ignore
  }
  state.code = "";
  state.lastHosts = [];
  state.hello = null;
  disconnect();
  log("Log out dari PC (kode dihapus dari HP ini)", "warn");
  emit({ t: "code", code: "" });
}

export function getStatus() {
  return {
    connected: state.connected,
    status: state.status,
    detail: state.detail,
    stage: state.stage,
    link: state.link,
    lastError: state.lastError,
    attempts: state.attempts,
    url: state.url,
    code: state.code,
    hello: state.hello,
    hosts: [...state.lastHosts],
    kicked: state.kicked,
    pcName: state.hello?.name || state.recent.find((r) => r.code === state.code)?.name || "",
    device: state.device,
  };
}

function setStatus(status, detail = "", stage = "") {
  state.status = status;
  if (detail !== undefined) state.detail = detail;
  if (stage) state.stage = stage;
  if (detail) log(detail, STATUS_LEVEL[status] || "info");
  emit({ t: "status", ...getStatus() });
}

function setProgress(stage, message) {
  state.stage = stage;
  state.detail = message;
  log(message, stage === "failed" ? "error" : "info");
  emit({ t: "progress", ...getStatus() });
}

export function send(obj) {
  if (state.ws && state.connected) {
    try {
      state.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Subscribe to screen JPEG frames. Only one screen consumer at a time. */
export function setScreenHandler(fn) {
  state.screenHandler = fn || null;
  if (state.ws && state.connected) send(msg.screen(Boolean(state.screenHandler)));
}

/**
 * Release the screen handler only if it is still the current owner.
 * Plain setScreenHandler(null) on blur is racy: if tab B focused (registered
 * itself) BEFORE tab A's blur cleanup runs, A's cleanup would clear B's
 * ownership and send screen(false) — freezing B's viewer with no watchdog
 * on GAME. Always use this in blur/unmount cleanups.
 */
export function releaseScreenHandler(fn) {
  if (fn && state.screenHandler === fn) setScreenHandler(null);
}

function handleTextMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === "hello") {
    state.hello = m;
    if (state.screenHandler) send(msg.screen(true));
    emit({ t: "hello", hello: m });
    return;
  }
  if (m.t === "pong") {
    state._lastPongAt = Date.now();
    state._pongMiss = 0;
    emit({ t: "pong", ts: m.ts });
    return;
  }
  emit(m);
}

function handleBinaryMessage(data) {
  const frame = parseBinaryFrame(data);
  if (!frame || frame.t !== "frame") return; // invalid: keep last valid frame
  if (state.screenHandler) {
    try {
      state.screenHandler(frame);
    } catch {
      // a slow renderer must not break the socket loop
    }
  }
}

function detectLink(wsUrl) {
  const u = String(wsUrl || "");
  if (/trycloudflare|ngrok|cfargotunnel|\.pages\.dev/i.test(u)) return "remote";
  if (/^wss:\/\//i.test(u)) return "remote";
  if (/^ws:\/\/127\.|^ws:\/\/localhost/i.test(u)) return "usb";
  return "wifi";
}

// Short host for status lines so the user can compare with the PC
// (tunnel hostname or LAN ip), never the full URL with ports.
function shortHost(wsUrl) {
  try {
    const u = String(wsUrl || "").replace(/^wss?:\/\//i, "").replace(/\/.*$/, "");
    if (u.length > 42) return `${u.slice(0, 18)}…${u.slice(-20)}`;
    return u || "?";
  } catch {
    return "?";
  }
}

export function connect(url, opts = {}) {
  disconnect(true);
  state._manualClose = false;
  state.kicked = false;
  state.url = url;
  state.link = detectLink(url);
  state.attempts = opts.attempt || 0;
  const gen = ++state._connectGen;
  setStatus("connecting", `Menghubungkan via ${state.link} (${shortHost(url)})…`, "ws-connecting");
  emit({ t: "progress", ...getStatus() });
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    state.lastError = `gagal-buka-socket: ${String(e?.message || e)}`;
    setStatus("unreachable", state.lastError, "ws-connecting");
    scheduleReconnect("open-failed");
    return;
  }
  try {
    ws.binaryType = "arraybuffer";
  } catch {
    // older runtimes ignore this and deliver text/base64 instead
  }
  state.ws = ws;
  ws.onopen = () => {
    if (gen !== state._connectGen) return;
    setProgress("auth", "Socket terbuka, mengirim auth…");
    // Auth must bypass send()'s connected-guard: hello (which sets
    // connected) only arrives AFTER auth. Using send() here deadlocks
    // pairing — the socket always closes via the auth timeout.
    try {
      ws.send(JSON.stringify(msg.auth(state.code, state.device || undefined)));
    } catch (e) {
      state.lastError = `gagal-kirim-auth: ${String(e?.message || e)}`;
    }
  };
  ws.onmessage = (event) => {
    if (gen !== state._connectGen) return;
    const data = event.data;
    if (typeof data === "string") {
      // Some runtimes deliver binary as base64 text — not used by the agent.
      handleTextMessage(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      handleBinaryMessage(data);
      return;
    }
    // Blob fallback (binary frames on runtimes without arraybuffer support).
    if (data && typeof data.arrayBuffer === "function") {
      data.arrayBuffer().then(handleBinaryMessage).catch(() => {});
    }
  };
  ws.onerror = () => {
    // error details surface via onclose
  };
  ws.onclose = (ev) => {
    if (gen !== state._connectGen) return;
    const wasUs = state.ws === ws;
    if (wasUs) {
      state.ws = null;
      state.connected = false;
      state.hello = null;
      const reason = ev?.reason || ev?.code ? `code=${ev?.code}` : "closed";
      state.lastError = `socket-tutup (${reason})`;
      emit({ t: "close", reason });
      if (state.kicked) {
        // The PC disconnected us on purpose: wait for the user.
      } else if (state._manualClose) {
        setStatus("idle", "Terputus (manual).", "idle");
      } else {
        setStatus(
          "reconnecting",
          `Terputus (${reason}). Mencoba lagi ${state.attempts + 1}/${MAX_RETRIES}…`,
          "ws-connecting",
        );
        scheduleReconnect(reason);
      }
    }
  };
  // Auth timeout: a silent socket is treated as unreachable.
  if (state._authTimer) clearTimeout(state._authTimer);
  state._authTimer = setTimeout(() => {
    if (gen !== state._connectGen) return;
    if (state.ws === ws && !state.connected) {
      try {
        ws.close();
      } catch {
        // already closing
      }
      state.lastError = "auth-timeout: PC tidak menjawab auth dalam 8 detik (kode salah / PC sibuk / tunnel mati)";
      setStatus("unreachable", state.lastError, "auth");
      scheduleReconnect("auth-timeout");
    }
  }, 8000);
}

function startPing() {
  stopPing();
  state._lastPongAt = Date.now();
  state._pongMiss = 0;
  state._pingTimer = setInterval(() => {
    if (state.ws && state.connected) {
      send(msg.ping());
      // Stale check 5s after ping: no pong = half-dead socket (tunnel putus).
      // Threshold 20s (was 30s): with 10s ping cadence the viewer stall
      // watchdog (4s resubscribe) covers visuals while this covers the socket.
      if (state._pongTimer) clearTimeout(state._pongTimer);
      state._pongTimer = setTimeout(() => {
        if (!state.connected || state._manualClose) return;
        if (Date.now() - state._lastPongAt > 20000) {
          state._pongMiss += 1;
          if (state._pongMiss >= 2) {
            state.lastError = "stalled: tidak ada pong 2x (koneksi setengah-mati)";
            setStatus("reconnecting", `${state.lastError}. Menyambung ulang…`, "ws-connecting");
            emit({ t: "stalled" });
            try {
              state.ws?.close();
            } catch {
              // will reconnect via onclose
            }
          } else {
            setStatus("reconnecting", "Tidak ada pong, menunggu sekali lagi…", "ws-connecting");
          }
        }
      }, 5000);
    }
  }, 10000);
}

function stopPing() {
  if (state._pingTimer) {
    clearInterval(state._pingTimer);
    state._pingTimer = null;
  }
  if (state._pongTimer) {
    clearTimeout(state._pongTimer);
    state._pongTimer = null;
  }
}

/** Auto-reconnect after an unexpected drop (not manual / kicked / wrong
 * code). Never gives up while the user wants the PC: backoff caps at 15 s,
 * and every 3rd try re-discovers the PC first (fresh ntfy announce + LAN),
 * because the tunnel URL changes when cloudflared restarts and the LAN IP
 * can change with DHCP. Returning to the app retries at once (AppState). */
function scheduleReconnect(reason) {
  if (state._manualClose || state.kicked || !state.url || state._reTimer) return;
  const tries = (state._reTries = (state._reTries || 0) + 1);
  state.attempts = tries;
  const delay = Math.min(15000, Math.round(1500 * Math.pow(1.5, Math.min(tries - 1, 8))));
  const label = tries > MAX_RETRIES ? `percobaan ${tries}` : `${tries}/${MAX_RETRIES}`;
  if (tries > MAX_RETRIES && tries === MAX_RETRIES + 1) {
    const hint = /1006/.test(String(reason || state.lastError)) ? " 1006 biasanya = tunnel restart / agent mati / beda jaringan." : "";
    log(`Sudah ${MAX_RETRIES}x gagal (${reason || state.lastError}).${hint} Terus mencoba tiap 15 dtk. Cek PCRemote.exe di PC.`, "error");
  }
  if (state.code && tries % 3 === 0) {
    setStatus("reconnecting", `Mencoba lagi ${label} — mencari ulang alamat PC…`, "polling-announce");
    state._reTimer = setTimeout(async () => {
      state._reTimer = null;
      if (state._manualClose || state.kicked || state.connected) return;
      let next = state.url;
      try {
        const fresh = await findPC(() => {}, { quiet: true });
        if (fresh) next = fresh;
        if (fresh && fresh !== state.url) log(`Alamat baru ditemukan: ${shortHost(fresh)}`, "ok");
      } catch (e) {
        log(`Cari ulang gagal: ${String(e?.message || e)}`, "warn");
      }
      if (!state._manualClose && !state.kicked && !state.connected) connect(next, { attempt: tries });
    }, delay);
    return;
  }
  setStatus("reconnecting", `Mencoba lagi ${label} dalam ${Math.round(delay / 1000)} dtk (${reason || state.lastError})…`, "ws-connecting");
  state._reTimer = setTimeout(() => {
    state._reTimer = null;
    if (!state._manualClose && !state.kicked && !state.connected && state.url) {
      connect(state.url, { attempt: tries });
    }
  }, delay);
}

export function retryConnect() {
  state.kicked = false;
  if (state._reTimer) {
    clearTimeout(state._reTimer);
    state._reTimer = null;
  }
  state._reTries = 0;
  state._rediscoveries = 0;
  state.attempts = 0;
  if (state.url) connect(state.url);
}

export function cancelFind() {
  state._findGen += 1;
}

// Mark connected when hello arrives (auth accepted).
addListener((event) => {
  if (event.t === "hello" && !state.connected) {
    if (state._authTimer) {
      clearTimeout(state._authTimer);
      state._authTimer = null;
    }
    state._reTries = 0;
    state._rediscoveries = 0;
    state.attempts = 0;
    state.connected = true;
    state.lastError = "";
    setStatus("connected", `Terhubung ke ${event.hello?.name || "PC"} via ${state.link || "wifi"} (${shortHost(state.url)}).`, "connected");
    rememberHost(state.url).then(() => {
      state.recent = upsertRecent(state.recent, {
        code: state.code,
        name: event.hello?.name || "PC",
        hosts: state.lastHosts,
        link: state.link,
      });
      return saveRecent();
    });
    startPing();
  }
  if (event.t === "kicked") {
    state.kicked = true;
    state.lastError = String(event.m || "Diputus dari PC");
    disconnect(true);
    setStatus("kicked", "Diputus dari dashboard PC. Tekan Connect untuk menyambung lagi.", "idle");
  }
  if (event.t === "error") {
    const m = String(event.m || "");
    // While connected, most errors are one failed command (webcam busy, a
    // key the PC refused): log it, keep the session. Only auth-type errors
    // end it. (Before, ANY error dropped the connection.)
    if (state.connected && !/bad token|blocked|lock code|credit/i.test(m)) {
      log(`PC: ${m || "error"}`, "warn");
      return;
    }
    state.lastError = m || "ditolak-agent";
    disconnect(true);
    if (/^blocked/i.test(m)) {
      state.kicked = true;
      setStatus("blocked", "HP ini diblokir di dashboard PC. Buka blokir di PC (Recent phones), lalu Connect.", "auth");
    } else if (/bad token|lock code/i.test(m)) {
      setStatus("rejected", "Kode ditolak PC: kode di PC sudah berubah. Scan QR baru di layar PC.", "auth");
    } else {
      setStatus("rejected", `Ditolak PC: ${m || "token salah"}.`, "auth");
    }
  }
  if (event.t === "close" && state.connected) {
    stopPing();
  }
});

/** "Putuskan" on the phone: stop and stay stopped until Connect. */
export function disconnectByUser() {
  disconnect(true);
  setStatus("stopped", "Diputus dari HP. Tekan Connect untuk menyambung lagi.", "idle");
}

export function disconnect(silent) {
  state._manualClose = true;
  state._connectGen += 1;
  const ws = state.ws;
  const was = state.connected;
  state.ws = null;
  state.connected = false;
  stopPing();
  if (state._authTimer) {
    clearTimeout(state._authTimer);
    state._authTimer = null;
  }
  if (state._reTimer) {
    clearTimeout(state._reTimer);
    state._reTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
  // Tabs leave for the connect screen on "close"; a manual / kicked
  // disconnect skips onclose (generation bump), so say it here.
  if (was) emit({ t: "close", reason: "manual" });
  if (!silent) setStatus("idle", "", "idle");
}

async function fetchTimeout(url, ms, options) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpToWs(http) {
  return String(http).replace(/^http/, "ws");
}

function wsToHttp(wsUrl) {
  return String(wsUrl).replace(/^ws/, "http");
}

async function checkHealth(httpBase, ms) {
  const res = await fetchTimeout(`${httpBase}/health`, ms);
  const health = await res.json();
  if (!health?.ok) throw new Error("not-agent");
  return health;
}

// First promise to resolve wins; rejects only when every one failed.
function firstOk(promises) {
  return new Promise((resolve, reject) => {
    let left = promises.length;
    if (!left) reject(new Error("empty"));
    for (const p of promises) {
      p.then(resolve, () => {
        left -= 1;
        if (!left) reject(new Error("none answered"));
      });
    }
  });
}

/**
 * Find the PC, validated, never blind:
 * 1. remembered hosts of THIS PC, all probed at once (/health, 2 s);
 * 2. encrypted ntfy announce from all boards at once, newest wins:
 *    its LAN addresses (parallel /health), then its tunnel (/health over
 *    https, so a dead old tunnel URL is never picked).
 * Returns a ws(s):// URL or throws with the reason. Every step is logged.
 */
export async function findPC(onProgress, opts = {}) {
  await loadStore();
  const gen = ++state._findGen;
  const rawProgress = onProgress || (() => {});
  const progress = (stage, message) => {
    if (gen !== state._findGen) throw new Error("cancelled");
    if (opts.quiet) log(message);
    else setProgress(stage, message);
    try {
      rawProgress(message);
    } catch {
      // UI progress must not break discovery
    }
    if (!opts.quiet) emit({ t: "progress", ...getStatus() });
  };
  const throwIfCancelled = () => {
    if (gen !== state._findGen) throw new Error("cancelled");
  };
  const t0 = Date.now();
  const took = () => `${((Date.now() - t0) / 1000).toFixed(1)} dtk`;

  // 1. Remembered hosts, in parallel.
  if (state.lastHosts.length) {
    progress("checking-saved", `Cek ${state.lastHosts.length} alamat tersimpan: ${state.lastHosts.map((h) => shortHost(h)).join(", ")}`);
    try {
      const http = await firstOk(state.lastHosts.map((h) => checkHealth(h, 2000).then(() => h)));
      throwIfCancelled();
      progress("checking-saved", `Ketemu di alamat tersimpan ${shortHost(http)} (${took()})`);
      return httpToWs(http);
    } catch (e) {
      if (String(e?.message).includes("cancelled")) throw e;
      progress("checking-saved", "Alamat tersimpan tidak menjawab (PC pindah jaringan / IP berubah).");
    }
  }

  if (!state.code) {
    progress("failed", "Belum ada kode pair. Scan QR di layar PC.");
    throw new Error("no-code");
  }

  // 2. Internet announce (works on mobile data too).
  progress("polling-announce", `Mencari PC via internet (${NTFY_HOSTS.length} server sekaligus)…`);
  const ann = await pollAnnounce();
  throwIfCancelled();
  if (!ann) {
    progress(
      "failed",
      "PC tidak mengumumkan alamat 10 menit terakhir. Pastikan PCRemote.exe jalan dan Internet di dashboard 'ready', lalu tekan Connect.",
    );
    throw new Error("not-found: no announce in 10 min");
  }
  const age = Math.max(0, Math.round((Date.now() - (Number(ann.ts) || Date.now())) / 1000));
  progress(
    "probing-candidate",
    `Announce ${ann.name || "PC"} (${age} dtk lalu): ${Array.isArray(ann.lan) ? ann.lan.length : 0} LAN, tunnel ${ann.tunnel ? "ada" : "belum ada"}`,
  );

  const lans = (Array.isArray(ann.lan) ? ann.lan : []).map((l) => `http://${l}`);
  if (lans.length) {
    progress("probing-candidate", `Uji LAN: ${lans.map(shortHost).join(", ")}`);
    try {
      const http = await firstOk(lans.map((h) => checkHealth(h, 2500).then(() => h)));
      throwIfCancelled();
      progress("probing-candidate", `Ketemu via Wi-Fi ${shortHost(http)} (${took()})`);
      return httpToWs(http);
    } catch (e) {
      if (String(e?.message).includes("cancelled")) throw e;
      progress("probing-candidate", "LAN tidak terjangkau (beda Wi-Fi / data seluler / AP isolation), coba internet…");
    }
  }

  if (ann.tunnel) {
    const host = shortHost(ann.tunnel);
    for (let i = 1; i <= 2; i += 1) {
      throwIfCancelled();
      progress("probing-candidate", `Uji tunnel ${host}${i > 1 ? " (ulang)" : ""}…`);
      try {
        await checkHealth(wsToHttp(ann.tunnel).replace(/\/$/, ""), 7000);
        progress("probing-candidate", `Tunnel OK (${took()})`);
        return ann.tunnel;
      } catch (e) {
        progress("probing-candidate", `Tunnel belum menjawab: ${String(e?.name === "AbortError" ? "timeout 7 dtk" : e?.message || e)}`);
      }
    }
    // The ws upgrade can still work when /health is slow at the edge.
    progress("probing-candidate", "Coba langsung WebSocket ke tunnel…");
    return ann.tunnel;
  }

  progress("failed", "Internet PC belum siap (tunnel belum ada) dan LAN tidak terjangkau. Sambungkan HP ke Wi-Fi yang sama atau tunggu Internet 'ready' di PC.");
  throw new Error("not-found: no reachable candidate");
}

/** Poll every ntfy board at once; the newest decryptable announce wins. */
async function pollAnnounce() {
  const room = roomIdForCode(state.code);
  const key = keyForCode(state.code);
  const topic = `${NTFY_PREFIX}${room}`;
  const results = await Promise.all(
    NTFY_HOSTS.map(async (host) => {
      try {
        const res = await fetchTimeout(`${host}/${topic}/json?since=10m&poll=1`, 8000);
        const text = await res.text();
        const bodies = [];
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.topic !== topic || !event.message) continue;
          const body = decryptAnnounce(event.message, key);
          if (body) bodies.push(body);
        }
        log(`ntfy ${host.replace(/^https:\/\//, "")}: ${bodies.length} announce`);
        return newestAnnounce(bodies);
      } catch (e) {
        log(`ntfy ${host.replace(/^https:\/\//, "")}: gagal (${e?.name === "AbortError" ? "timeout" : String(e?.message || e)})`, "warn");
        return null;
      }
    }),
  );
  return newestAnnounce(results);
}

/** Direct-probe one host:port for the agent /health endpoint. */
export async function probeHost(host, port = DEFAULT_PORT) {
  const clean = String(host).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const base = `http://${clean}:${Number(port) || DEFAULT_PORT}`;
  const res = await fetchTimeout(`${base}/health`, 3000);
  const health = await res.json();
  if (!health?.ok) throw new Error("not-agent");
  return httpToWs(base);
}

let appStateSub = null;
export async function boot() {
  await loadStore();
  if (!appStateSub) {
    // Back in the app with a dropped link: retry now instead of waiting
    // out the backoff (Android pauses timers in the background).
    appStateSub = AppState.addEventListener("change", (s) => {
      if (s !== "active" || state.connected || state.kicked || state._manualClose || !state.url) return;
      log("Aplikasi aktif lagi, menyambung ulang sekarang…");
      retryConnect();
    });
  }
  emit({ t: "code", code: state.code });
}

/** Pair with a code (typed, QR, or a recent PC) and connect. QR hosts are
 * tried first in parallel; otherwise normal discovery. */
export async function connectToCode(code, { hosts = [], onProgress } = {}) {
  const clean = normalizeCode(code);
  if (clean.length < 8) throw new Error("bad-code");
  await loadStore();
  await setLockCode(clean);
  state.kicked = false;
  log(`Mulai konek${state.recent.find((r) => r.code === clean)?.name ? ` ke ${state.recent.find((r) => r.code === clean).name}` : ""} (HP: ${state.device?.name || "?"})`);
  if (hosts.length) {
    const list = hosts.map((h) => `http://${h.host}:${h.port || DEFAULT_PORT}`);
    setProgress("probing-candidate", `QR: uji ${list.map(shortHost).join(", ")}`);
    try {
      const http = await firstOk(list.map((h) => checkHealth(h, 2500).then(() => h)));
      setProgress("probing-candidate", `QR: ketemu ${shortHost(http)}`);
      connect(httpToWs(http));
      return;
    } catch {
      setProgress("probing-candidate", "QR: alamat LAN tidak terjangkau, cari lewat internet…");
    }
  }
  const url = await findPC(onProgress);
  connect(url);
}

/** React hook: true once the agent hello (auth accepted) arrives. */
export function useIsConnected() {
  const [connected, setConnected] = React.useState(state.connected);
  React.useEffect(() => {
    return addListener((event) => {
      if (event.t === "hello") setConnected(true);
      if (event.t === "close") setConnected(false);
    });
  }, []);
  return connected;
}

/** React hook: full status (stage/detail/link/attempts) for detailed UI. */
export function useConnectionStatus() {
  const [st, setSt] = React.useState(getStatus());
  React.useEffect(() => {
    return addListener((event) => {
      if (event.t === "status" || event.t === "progress" || event.t === "hello" || event.t === "close" || event.t === "failed") {
        setSt(getStatus());
      }
    });
  }, []);
  return st;
}
