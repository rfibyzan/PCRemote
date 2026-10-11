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
  state.code = normalizeCode(code);
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
  disconnect();
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
  };
}

function setStatus(status, detail = "", stage = "") {
  state.status = status;
  if (detail !== undefined) state.detail = detail;
  if (stage) state.stage = stage;
  emit({ t: "status", ...getStatus() });
}

function setProgress(stage, message) {
  state.stage = stage;
  state.detail = message;
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
      ws.send(JSON.stringify(msg.auth(state.code)));
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
      if (state._manualClose) {
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

/** Auto-reconnect with backoff after an unexpected drop (not manual). */
function scheduleReconnect(reason) {
  if (state._manualClose || !state.url || state._reTimer) return;
  const tries = (state._reTries = (state._reTries || 0) + 1);
  state.attempts = tries;
  if (tries > MAX_RETRIES) {
    const hint = /1006/.test(String(reason || state.lastError))
      ? " (1006 = putus abnormal: biasanya tunnel mati/restart, agent tidak jalan, atau kode beda — cek tray PC + kode sama, lalu Connect ulang untuk cari URL baru)"
      : "";
    setStatus(
      "failed",
      `Gagal ${MAX_RETRIES}x (${reason || state.lastError})${hint}. Cek PC menyala + kode sama, lalu tekan Coba lagi.`,
      "failed",
    );
    emit({ t: "failed", reason, ...getStatus() });
    return;
  }
  const delay = Math.min(15000, Math.round(2000 * Math.pow(1.5, Math.min(tries, 8))));
  // Stale-URL recovery: cloudflared quick tunnels get a NEW random URL on
  // every restart, so hammering the same URL 10x is pointless when the PC
  // re-announced elsewhere. On tries 3 and 6, re-discover first (fresh ntfy
  // announce + LAN recheck) instead of redialing the dead URL. Bounded by
  // _rediscoveries (max 2): without this, resetting _reTries on every
  // rediscovery that returns the SAME dead URL loops forever and MAX_RETRIES
  // is never reached (stuck "reconnecting" with a resetting counter).
  const shouldRediscover =
    state.link === "remote" && (tries === 3 || tries === 6) && state.code && (state._rediscoveries || 0) < 2;
  if (shouldRediscover) {
    setStatus(
      "reconnecting",
      `Mencoba lagi ${tries}/${MAX_RETRIES} — URL tunnel mungkin basi, mencari ulang PC…`,
      "polling-announce",
    );
    state._reTimer = setTimeout(async () => {
      state._reTimer = null;
      if (state._manualClose || state.connected) return;
      try {
        const fresh = await findPC(() => {});
        if (state._manualClose || state.connected) return;
        if (fresh && fresh !== state.url) {
          // Genuinely new URL: fresh attempt series against the new address.
          state._rediscoveries = (state._rediscoveries || 0) + 1;
          state._reTries = 0;
          state.attempts = 0;
          connect(fresh);
        } else {
          // Same (still dead) URL or nothing new: keep counting so MAX still trips.
          state._rediscoveries = (state._rediscoveries || 0) + 1;
          if (!state._manualClose && !state.connected && state.url) {
            connect(state.url, { attempt: tries });
          }
        }
      } catch {
        // Rediscovery found nothing new: keep hammering the old URL; the
        // next rediscover (or MAX) will handle it.
        if (!state._manualClose && !state.connected && state.url) {
          connect(state.url, { attempt: tries });
        }
      }
    }, delay);
    return;
  }
  setStatus(
    "reconnecting",
    `Mencoba lagi ${tries}/${MAX_RETRIES} dalam ${Math.round(delay / 1000)}s (${reason || state.lastError})…`,
    "ws-connecting",
  );
  state._reTimer = setTimeout(() => {
    state._reTimer = null;
    if (!state._manualClose && !state.connected && state.url) {
      connect(state.url, { attempt: tries });
    }
  }, delay);
}

export function retryConnect() {
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
    setStatus("connected", `Terhubung via ${state.link || "wifi"}.`, "connected");
    rememberHost(state.url);
    startPing();
  }
  if (event.t === "error") {
    const m = String(event.m || "");
    state.lastError = m || "ditolak-agent";
    disconnect();
    setStatus("rejected", `Ditolak PC: ${m || "token salah"}. Cek kode di tray PC.`, "auth");
  }
  if (event.t === "close" && state.connected) {
    stopPing();
  }
});

export function disconnect(silent) {
  state._manualClose = true;
  state._connectGen += 1;
  const ws = state.ws;
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

/**
 * Find the PC: remembered hosts first (fast, validated), then the encrypted
 * ntfy internet announce (all candidates validated), never blind-connect.
 * Returns a ws:// URL or throws with a detailed reason.
 */
export async function findPC(onProgress) {
  await loadStore();
  const gen = ++state._findGen;
  const rawProgress = onProgress || (() => {});
  const progress = (stage, message) => {
    if (gen !== state._findGen) throw new Error("cancelled");
    setProgress(stage, message);
    try {
      rawProgress(message);
    } catch {
      // UI progress must not break discovery
    }
    emit({ t: "progress", ...getStatus() });
  };
  const throwIfCancelled = () => {
    if (gen !== state._findGen) throw new Error("cancelled");
  };

  // 1. Remembered hosts (validated via /health, per-host progress).
  if (state.lastHosts.length) {
    let i = 0;
    for (const http of state.lastHosts) {
      i += 1;
      throwIfCancelled();
      progress("checking-saved", `Cek tersimpan ${i}/${state.lastHosts.length}: ${http}…`);
      try {
        await checkHealth(http, 1500);
        progress("checking-saved", `Ketemu di tersimpan: ${http}`);
        return httpToWs(http);
      } catch {
        // try next
      }
    }
  } else {
    progress("checking-saved", "Belum ada host tersimpan, lanjut ke internet…");
  }

  // 2. ntfy internet announce (works on mobile data too). Collect ALL
  // candidates (tunnel + lan), validate each. LAN first: on the same Wi-Fi
  // it is always more reliable than the tunnel (no Cloudflare in the path);
  // tunnel is for mobile-data / off-LAN only.
  if (state.code) {
    progress("polling-announce", "Mencari PC via internet (ntfy)…");
    const candidates = await pollAnnounceCandidates((m) => progress("polling-announce", m));
    throwIfCancelled();
    if (candidates.length) {
      const lans = candidates.filter((c) => c.kind !== "tunnel");
      const tunnels = candidates.filter((c) => c.kind === "tunnel");
      let i = 0;
      for (const c of lans) {
        i += 1;
        throwIfCancelled();
        progress("probing-candidate", `Uji LAN ${i}/${lans.length}: ${c.label}…`);
        try {
          await checkHealth(c.http, 2000);
          progress("probing-candidate", `Ketemu via LAN: ${c.http}`);
          return httpToWs(c.http);
        } catch {
          // try next candidate
        }
      }
      let j = 0;
      for (const c of tunnels) {
        j += 1;
        throwIfCancelled();
        progress("probing-candidate", `Uji tunnel ${j}/${tunnels.length}: ${c.label}…`);
        try {
          // Tunnel ws can't be health-checked via /health over http the way
          // LAN can; a bare https GET only proves the edge is alive.
          // If that fails, still keep it as last resort (don't drop).
          const ok = await probeTunnelHttp(c.url).catch(() => false);
          if (ok) {
            progress("probing-candidate", `Tunnel OK: ${c.url}`);
            return c.url;
          }
          // keep tunnel as fallback, continue checking the rest
          continue;
        } catch {
          // try next candidate
        }
      }
      // Last resort: first tunnel even if http probe failed (ws may work).
      if (tunnels.length) {
        progress("probing-candidate", `Coba tunnel walau probe gagal: ${tunnels[0].url}`);
        return tunnels[0].url;
      }
    } else {
      progress("polling-announce", "Tidak ada announce 10 menit terakhir.");
    }
  } else {
    progress("polling-announce", "Belum ada kode pair, lewati internet.");
  }

  // 3. Manual host remains (UI offers entry via probeHost).
  progress("failed", "PC tidak ketemu. Nyalakan PC Remote di komputer / masukkan host manual.");
  throw new Error("not-found: no validated candidate (saved empty/mati, ntfy kosong/kedaluwarsa)");
}

async function probeTunnelHttp(tunnelWs) {
  const http = wsToHttp(tunnelWs).replace(/\/$/, "");
  // Cloudflared tunnel root usually 404/200 but reachable; just need TCP+TLS.
  const res = await fetchTimeout(http, 5000, { method: "GET" });
  // Any http response (even 404) means tunnel alive.
  return res.status < 600;
}

async function pollAnnounceCandidates(onNote) {
  const room = roomIdForCode(state.code);
  const key = keyForCode(state.code);
  const topic = `${NTFY_PREFIX}${room}`;
  const out = [];
  const seen = new Set();
  let board = 0;
  for (const host of NTFY_HOSTS) {
    board += 1;
    try {
      if (onNote) onNote(`Poll ${host} (${board}/${NTFY_HOSTS.length})…`);
      const res = await fetchTimeout(`${host}/${topic}/json?since=10m&poll=1`, 9000);
      const text = await res.text();
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
        if (!body) continue;
        if (body.tunnel && !seen.has(body.tunnel)) {
          seen.add(body.tunnel);
          out.push({ kind: "tunnel", url: body.tunnel, label: `tunnel ${body.tunnel.slice(0, 40)}…` });
        }
        if (Array.isArray(body.lan)) {
          for (const lan of body.lan) {
            const http = `http://${lan}`;
            if (!seen.has(http)) {
              seen.add(http);
              out.push({ kind: "lan", http, label: `lan ${lan}` });
            }
          }
        }
      }
      if (out.length) break; // first board with data wins (freshest)
    } catch {
      // try next board
    }
  }
  return out;
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

export async function boot() {
  await loadStore();
  emit({ t: "code", code: state.code });
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
