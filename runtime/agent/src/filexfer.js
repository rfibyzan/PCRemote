/**
 * File transfer PC <-> phones over the existing WebSocket (JSON, base64).
 * The protocol is the same both ways (mobile/src/filexfer.js speaks it too):
 *
 *   sender   {t:"fileStart", id, name, size}      receiver {t:"fileReady", id}
 *   sender   {t:"fileChunk", id, seq, b64}        receiver {t:"fileAck", id, got}
 *   sender   {t:"fileEnd", id}                    receiver {t:"fileDone", id, name, path}
 *   either   {t:"fileCancel", id}                 either   {t:"fileError", id, error}
 *
 * Flow control: at most WINDOW chunks wait for an ack, so a big file never
 * floods the socket the stream and input share.
 * Phone -> PC files land in %USERPROFILE%\Downloads\PC Remote.
 * PC -> phone: Explorer "Send to > PC Remote (HP)" (sendto.js) posts the
 * paths to the agent, which pushes them to every connected phone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const CHUNK = 48 * 1024;
export const WINDOW = 8;
export const MAX_FILE = 2 * 1024 * 1024 * 1024; // 2 GB
const STEP_TIMEOUT_MS = 20000;

export function defaultInbox() {
  return path.join(os.homedir(), "Downloads", "PC Remote");
}

/** A name that is safe as a single Windows file name. */
export function safeName(name) {
  let s = String(name ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 180);
  if (!s) s = "file";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
  return s;
}

/** dir\name, or dir\name (1).ext, (2)... when it already exists. */
export function uniquePath(dir, name, exists = fs.existsSync) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; exists(p); i += 1) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

export function createFileTransfer({ send, inbox = defaultInbox, log = () => {} }) {
  const inbound = new Map(); // ws -> Map(id -> {fd, p, size, got, seq})
  const outbound = new Map(); // id -> waiter state for a file we send

  function inOf(ws) {
    let m = inbound.get(ws);
    if (!m) inbound.set(ws, (m = new Map()));
    return m;
  }

  function closeIn(ws, id, unlink) {
    const e = inbound.get(ws)?.get(id);
    if (!e) return null;
    inbound.get(ws).delete(id);
    try {
      fs.closeSync(e.fd);
    } catch {
      // already closed
    }
    if (unlink) {
      try {
        fs.unlinkSync(e.p);
      } catch {
        // nothing written yet
      }
    }
    return e;
  }

  function failIn(ws, id, error) {
    closeIn(ws, id, true);
    send(ws, { t: "fileError", id, error });
  }

  // ---- receiving (phone -> PC) ----
  function onStart(ws, m) {
    const id = String(m.id || "");
    const size = Number(m.size);
    if (!id || !Number.isFinite(size) || size < 0) return send(ws, { t: "fileError", id, error: "permintaan tidak valid" });
    if (size > MAX_FILE) return send(ws, { t: "fileError", id, error: "file lebih dari 2 GB" });
    try {
      const dir = inbox();
      fs.mkdirSync(dir, { recursive: true });
      const p = uniquePath(dir, safeName(m.name));
      const fd = fs.openSync(p, "w");
      inOf(ws).set(id, { fd, p, size, got: 0, seq: 0 });
      send(ws, { t: "fileReady", id });
    } catch (err) {
      send(ws, { t: "fileError", id, error: `tidak bisa menyimpan: ${err?.code || err?.message || err}` });
    }
  }

  function onChunk(ws, m) {
    const id = String(m.id || "");
    const e = inbound.get(ws)?.get(id);
    if (!e) return;
    if (Number(m.seq) !== e.seq) return failIn(ws, id, "potongan file tidak berurutan");
    const buf = Buffer.from(String(m.b64 || ""), "base64");
    if (e.got + buf.length > e.size) return failIn(ws, id, "ukuran file tidak cocok");
    try {
      fs.writeSync(e.fd, buf);
    } catch (err) {
      return failIn(ws, id, `gagal menulis: ${err?.code || err?.message || err}`);
    }
    e.got += buf.length;
    e.seq += 1;
    send(ws, { t: "fileAck", id, got: e.got });
  }

  function onEnd(ws, m) {
    const id = String(m.id || "");
    const e = inbound.get(ws)?.get(id);
    if (!e) return;
    if (e.got !== e.size) return failIn(ws, id, "file tidak lengkap");
    closeIn(ws, id, false);
    const name = path.basename(e.p);
    log(`File diterima dari HP: ${e.p}`);
    send(ws, { t: "fileDone", id, name, path: e.p });
  }

  // ---- sending (PC -> phone) ----
  function waitFor(st, pred) {
    return new Promise((resolve, reject) => {
      if (st.error) return reject(new Error(st.error));
      if (pred()) return resolve();
      const timer = setTimeout(() => {
        st.wake = null;
        reject(new Error("HP tidak menjawab"));
      }, STEP_TIMEOUT_MS);
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

  async function sendOne(ws, file) {
    const id = randomBytes(6).toString("hex");
    const st = { ws, ready: false, acked: 0, done: false, error: null, wake: null };
    outbound.set(id, st);
    let fd = null;
    try {
      send(ws, { t: "fileStart", id, name: file.name, size: file.size });
      await waitFor(st, () => st.ready);
      fd = fs.openSync(file.p, "r");
      const buf = Buffer.alloc(CHUNK);
      let seq = 0;
      let sent = 0;
      while (sent < file.size) {
        await waitFor(st, () => seq - st.acked < WINDOW);
        if (ws.readyState !== 1) throw new Error("HP terputus");
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, file.size - sent), sent);
        if (n <= 0) throw new Error("file berubah saat dikirim");
        send(ws, { t: "fileChunk", id, seq, b64: buf.subarray(0, n).toString("base64") });
        sent += n;
        seq += 1;
      }
      await waitFor(st, () => st.acked >= seq);
      send(ws, { t: "fileEnd", id });
      await waitFor(st, () => st.done);
      return true;
    } catch (err) {
      if (!st.error) send(ws, { t: "fileCancel", id });
      log(`Kirim ${file.name} ke HP gagal: ${err?.message || err}`);
      return false;
    } finally {
      if (fd != null) fs.closeSync(fd);
      outbound.delete(id);
    }
  }

  function onReply(m) {
    const st = outbound.get(String(m.id || ""));
    if (!st) return false;
    if (m.t === "fileReady") st.ready = true;
    else if (m.t === "fileAck") st.acked += 1;
    else if (m.t === "fileDone") st.done = true;
    else if (m.t === "fileError" || m.t === "fileCancel") st.error = String(m.error || "dibatalkan di HP");
    st.wake?.();
    return true;
  }

  return {
    /** Handles a file message; true when it was one. */
    onMessage(ws, m) {
      switch (m.t) {
        case "fileStart":
          onStart(ws, m);
          return true;
        case "fileChunk":
          onChunk(ws, m);
          return true;
        case "fileEnd":
          onEnd(ws, m);
          return true;
        case "fileCancel":
          if (!onReply(m)) closeIn(ws, String(m.id || ""), true);
          return true;
        case "fileReady":
        case "fileAck":
        case "fileDone":
        case "fileError":
          onReply(m);
          return true;
        default:
          return false;
      }
    },

    /** Explorer "Send to": push these files to every phone. */
    async sendPaths(paths, phones) {
      const files = [];
      for (const raw of paths || []) {
        try {
          const p = String(raw);
          const s = fs.statSync(p);
          if (s.isFile() && s.size <= MAX_FILE) files.push({ p, name: safeName(path.basename(p)), size: s.size });
        } catch {
          // gone / no access: skip
        }
      }
      let ok = 0;
      for (const ws of phones) for (const f of files) if (await sendOne(ws, f)) ok += 1;
      return { files: files.length, ok };
    },

    /** A phone left: drop its half-received files. */
    drop(ws) {
      for (const id of [...(inbound.get(ws)?.keys() || [])]) closeIn(ws, id, true);
      inbound.delete(ws);
      for (const st of outbound.values()) {
        if (st.ws === ws) {
          st.error = "HP terputus";
          st.wake?.();
        }
      }
    },
  };
}
