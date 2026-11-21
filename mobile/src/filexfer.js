/**
 * File transfer phone <-> PC over the shared WebSocket. Same protocol as the
 * agent (runtime/agent/src/filexfer.js), both ways:
 *
 *   sender   {t:"fileStart", id, name, size}      receiver {t:"fileReady", id}
 *   sender   {t:"fileChunk", id, seq, b64}        receiver {t:"fileAck", id, got}
 *   sender   {t:"fileEnd", id}                    receiver {t:"fileDone", id, name, path}
 *   either   {t:"fileCancel", id}                 either   {t:"fileError", id, error}
 *
 * Phone -> PC: "Kirim file ke PC" (viewer > Lainnya) picks files; they land
 * in Downloads\PC Remote on the PC.
 * PC -> phone: Explorer "Send to > PC Remote (HP)". Files are received into
 * the app's own folder (Paths.document/PC Remote), then "Buka" (share sheet:
 * open with / save to Drive...) or "Simpan" (a folder picked once).
 * At most WINDOW chunks wait for an ack, so the stream keeps flowing.
 */
import { useEffect, useState } from "react";
import { NEEDS_NEW_BUILD, optionalModule } from "./optionalmodule";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { addListener, getStatus, send } from "./connection";
import { waitUntil } from "./waituntil";

// Native modules: missing in older builds -> a clear message, not a crash.
const DocumentPicker = optionalModule(() => require("expo-document-picker"));
const Sharing = optionalModule(() => require("expo-sharing"));
const CHUNK = 48 * 1024;
const WINDOW = 8;
const STEP_TIMEOUT_MS = 20000;
// After the file picker the app was in the background and the link may still
// be coming back: wait this long for it before giving up.
const CONNECT_WAIT_MS = 15000;
// A live PC answers fileStart at once; silence this long = dead socket.
const HANDSHAKE_MS = 5000;
const STORE_SAVE_DIR = "pcremote.savedir";

// ---- transfer list (newest first) for the panel ----
let transfers = [];
const listeners = new Set();
let emitTimer = null;
function emitNow() {
  emitTimer = null;
  for (const l of [...listeners]) l();
}
/** Progress is throttled (~4 Hz); status changes go out at once. */
function emit(now = true) {
  if (now) {
    if (emitTimer) clearTimeout(emitTimer);
    emitNow();
  } else if (!emitTimer) {
    emitTimer = setTimeout(emitNow, 250);
  }
}
function add(tr) {
  transfers = [tr, ...transfers].slice(0, 8);
  emit();
  return tr;
}
function patch(id, p, now = true) {
  transfers = transfers.map((t) => (t.id === id ? { ...t, ...p } : t));
  emit(now);
}
export function dismissTransfer(id) {
  transfers = transfers.filter((t) => t.id !== id || t.status === "sending" || t.status === "receiving" || t.status === "waiting");
  emit();
}
export function useTransfers() {
  const [list, setList] = useState(transfers);
  useEffect(() => {
    const l = () => setList(transfers);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return list;
}

function newId() {
  return Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
}

// ---- sending (phone -> PC) ----
// fresh: ignore "connected" (it may be a socket that died while the app was
// in the background) and wait for the next hello.
function waitConnected(fresh = false) {
  return waitUntil({
    isReady: () => !fresh && getStatus().connected,
    subscribe: addListener,
    match: (e) => e.t === "hello",
    timeoutMs: CONNECT_WAIT_MS,
    timeoutMessage: "PC belum tersambung lagi, coba kirim ulang",
  });
}

const out = new Map(); // id -> { ready, acked, done, error, path, wake }

function waitFor(st, pred, ms = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (st.error) return reject(new Error(st.error));
    if (pred()) return resolve();
    const timer = setTimeout(() => {
      st.wake = null;
      reject(new Error("PC tidak menjawab"));
    }, ms);
    st.wake = () => {
      if (st.error) {
        clearTimeout(timer);
        st.wake = null;
        reject(new Error(st.error));
      } else if (pred()) {
        clearTimeout(timer);
        st.wake = null;
        resolve();
      }
    };
  });
}

async function sendOne(asset) {
  const id = newId();
  const file = new File(asset.uri);
  const size = Number(asset.size ?? file.size) || 0;
  const tr = add({ id, dir: "out", name: asset.name || file.name || "file", size, got: 0, status: getStatus().connected ? "sending" : "waiting" });
  const st = { ready: false, acked: 0, done: false, error: null, path: "", wake: null };
  let handle = null;
  let started = false;
  try {
    // Handshake, with one retry: right after the picker the link can still
    // look connected while it is dead (or about to be swapped), so a lost
    // fileStart waits for a fresh connection and tries again.
    for (let attempt = 0; ; attempt += 1) {
      await waitConnected(attempt > 0);
      // Registered only once connected: a "close" while waiting must not
      // mark this transfer as broken before it even started.
      Object.assign(st, { ready: false, acked: 0, done: false, error: null, wake: null });
      out.set(id, st);
      patch(id, { status: "sending" });
      started = true;
      try {
        if (!send({ t: "fileStart", id, name: tr.name, size })) throw new Error("tidak tersambung ke PC");
        await waitFor(st, () => st.ready, HANDSHAKE_MS);
        break;
      } catch (err) {
        if (attempt > 0 || st.error === "dibatalkan di PC" || (st.error && st.error !== "koneksi putus")) throw err;
        send({ t: "fileCancel", id });
        out.delete(id);
        started = false;
        patch(id, { status: "waiting" });
      }
    }
    handle = file.open();
    let seq = 0;
    let sent = 0;
    while (sent < size) {
      await waitFor(st, () => seq - st.acked < WINDOW);
      const bytes = handle.readBytes(Math.min(CHUNK, size - sent));
      if (!bytes.length) throw new Error("file tidak bisa dibaca");
      if (!send({ t: "fileChunk", id, seq, b64: encodeBase64(bytes) })) throw new Error("koneksi ke PC putus");
      sent += bytes.length;
      seq += 1;
    }
    await waitFor(st, () => st.acked >= seq);
    send({ t: "fileEnd", id });
    await waitFor(st, () => st.done);
    patch(id, { status: "done", got: size, path: st.path });
  } catch (err) {
    if (started && !st.error) send({ t: "fileCancel", id });
    patch(id, { status: "error", error: String(err?.message || err) });
  } finally {
    try {
      handle?.close();
    } catch {
      // closed
    }
    out.delete(id);
    // The picker's cache copy is not needed any more.
    try {
      if (file.uri.includes("/cache/")) file.delete();
    } catch {
      // best effort
    }
  }
}

/** "Kirim file ke PC": pick one or more files and send them one by one. */
export async function pickAndSend() {
  if (!DocumentPicker) throw new Error(NEEDS_NEW_BUILD);
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.length) return;
  for (const a of res.assets) await sendOne(a);
}

function onReply(m) {
  const st = out.get(String(m.id || ""));
  if (!st) return false;
  if (m.t === "fileReady") st.ready = true;
  else if (m.t === "fileAck") {
    st.acked += 1;
    patch(m.id, { got: Number(m.got) || 0 }, false);
  } else if (m.t === "fileDone") {
    st.done = true;
    st.path = String(m.path || "");
  } else st.error = String(m.error || "dibatalkan di PC");
  st.wake?.();
  return true;
}

// ---- receiving (PC -> phone) ----
const inn = new Map(); // id -> { file, handle, size, got, seq }

function inboxDir() {
  const dir = new Directory(Paths.document, "PC Remote");
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function uniqueFile(dir, name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let f = new File(dir, name);
  for (let i = 1; f.exists; i += 1) f = new File(dir, `${base} (${i})${ext}`);
  return f;
}

function safeName(name) {
  const s = String(name || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[:*?"<>|\x00-\x1f]/g, "_")
    .trim()
    .slice(0, 180);
  return s || "file";
}

function closeIn(id, remove) {
  const e = inn.get(id);
  if (!e) return null;
  inn.delete(id);
  try {
    e.handle.close();
  } catch {
    // closed
  }
  if (remove) {
    try {
      e.file.delete();
    } catch {
      // nothing written
    }
  }
  return e;
}

function failIn(id, error) {
  closeIn(id, true);
  send({ t: "fileError", id, error });
  patch(id, { status: "error", error });
}

function onStart(m) {
  const id = String(m.id || "");
  const size = Number(m.size);
  if (!id || !Number.isFinite(size) || size < 0) return;
  const name = safeName(m.name);
  try {
    const file = uniqueFile(inboxDir(), name);
    file.create();
    const handle = file.open();
    inn.set(id, { file, handle, size, got: 0, seq: 0 });
    add({ id, dir: "in", name: file.name || name, size, got: 0, status: "receiving", uri: file.uri });
    send({ t: "fileReady", id });
  } catch (err) {
    send({ t: "fileError", id, error: `HP tidak bisa menyimpan: ${err?.message || err}` });
  }
}

function onChunk(m) {
  const id = String(m.id || "");
  const e = inn.get(id);
  if (!e) return;
  if (Number(m.seq) !== e.seq) return failIn(id, "potongan file tidak berurutan");
  let bytes;
  try {
    bytes = decodeBase64(String(m.b64 || ""));
  } catch {
    return failIn(id, "data rusak");
  }
  if (e.got + bytes.length > e.size) return failIn(id, "ukuran file tidak cocok");
  try {
    e.handle.writeBytes(bytes);
  } catch (err) {
    return failIn(id, `gagal menulis: ${err?.message || err}`);
  }
  e.got += bytes.length;
  e.seq += 1;
  send({ t: "fileAck", id, got: e.got });
  patch(id, { got: e.got }, false);
}

function onEnd(m) {
  const id = String(m.id || "");
  const e = inn.get(id);
  if (!e) return;
  if (e.got !== e.size) return failIn(id, "file tidak lengkap");
  closeIn(id, false);
  send({ t: "fileDone", id, name: e.file.name });
  patch(id, { status: "done", got: e.size });
}

// ---- actions on a received file ----
const MIME = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  txt: "text/plain",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function mimeOf(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

/** "Buka": Android share sheet (open with an app, save to Drive/Files...). */
export async function openReceived(tr) {
  if (!Sharing) throw new Error(NEEDS_NEW_BUILD);
  if (!(await Sharing.isAvailableAsync())) throw new Error("berbagi tidak tersedia di HP ini");
  await Sharing.shareAsync(tr.uri, { mimeType: mimeOf(tr.name), dialogTitle: tr.name });
}

const SAVE_MAX = 200 * 1024 * 1024; // whole file goes through memory once

/** "Simpan": copy into a folder the user picked once (e.g. Download). */
export async function saveReceived(tr) {
  const src = new File(tr.uri);
  if (src.size > SAVE_MAX) throw new Error("file terlalu besar untuk Simpan, pakai Buka lalu pilih aplikasi File");
  let dir = null;
  try {
    const saved = await SecureStore.getItemAsync(STORE_SAVE_DIR);
    if (saved) dir = new Directory(saved);
  } catch {
    dir = null;
  }
  const writeTo = async (d) => {
    const dest = d.createFile(tr.name, mimeOf(tr.name));
    dest.write(await src.bytes());
    return dest;
  };
  try {
    if (!dir) throw new Error("no dir");
    await writeTo(dir);
  } catch {
    // First time, or the old folder permission is gone: ask once more.
    dir = await Directory.pickDirectoryAsync();
    if (!dir) return false;
    await SecureStore.setItemAsync(STORE_SAVE_DIR, dir.uri).catch(() => {});
    await writeTo(dir);
  }
  patch(tr.id, { saved: true });
  return true;
}

// ---- wiring ----
let started = false;
/** Start once (app root). */
export function startFileTransfer() {
  if (started) return;
  started = true;
  addListener((m) => {
    switch (m.t) {
      case "fileStart":
        onStart(m);
        break;
      case "fileChunk":
        onChunk(m);
        break;
      case "fileEnd":
        onEnd(m);
        break;
      case "fileCancel":
        if (!onReply(m)) {
          closeIn(String(m.id || ""), true);
          patch(m.id, { status: "error", error: "dibatalkan di PC" });
        }
        break;
      case "fileReady":
      case "fileAck":
      case "fileDone":
      case "fileError":
        onReply(m);
        break;
      case "close":
        for (const id of [...inn.keys()]) {
          closeIn(id, true);
          patch(id, { status: "error", error: "koneksi putus" });
        }
        for (const st of out.values()) {
          st.error = "koneksi putus";
          st.wake?.();
        }
        break;
      default:
        break;
    }
  });
}
