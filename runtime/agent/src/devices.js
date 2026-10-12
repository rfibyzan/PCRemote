/**
 * Phones that paired with this PC: who they are, when they were last seen,
 * and which ones the user blocked from the dashboard. Stored next to
 * lock.json (devices.json). The phone sends {id,name,model,os,app} in its
 * auth message; old phones send nothing and are tracked by IP instead.
 * Also keeps a small in-memory connection log for the dashboard.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockPath } from "./lock.js";

const MAX_DEVICES = 30;
const MAX_LOG = 60;

export function devicesPath() {
  if (process.env.PCREMOTE_DEVICES) return process.env.PCREMOTE_DEVICES;
  return join(dirname(lockPath()), "devices.json");
}

function clip(v, n = 60) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, n);
}

/** Clean what the phone claims about itself. Never trusted for auth. */
export function sanitizeDevice(raw, ip = "") {
  const d = raw && typeof raw === "object" ? raw : {};
  let id = clip(d.id, 64).replace(/[^\w.:-]/g, "");
  if (!id) id = `ip-${clip(ip, 45) || "unknown"}`;
  return {
    id,
    name: clip(d.name) || "Unknown phone",
    model: clip(d.model),
    os: clip(d.os, 30),
    app: clip(d.app, 20),
  };
}

export function createDeviceStore(file = devicesPath()) {
  let data = { devices: {}, blocked: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw.devices === "object") data.devices = raw.devices;
    if (Array.isArray(raw?.blocked)) data.blocked = raw.blocked.map(String);
  } catch {
    // first run
  }
  const log = [];

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    } catch {
      // device memory is best-effort
    }
  }

  function prune() {
    const all = Object.values(data.devices).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    for (const d of all.slice(MAX_DEVICES)) {
      if (!data.blocked.includes(d.id)) delete data.devices[d.id];
    }
  }

  return {
    isBlocked(id) {
      return data.blocked.includes(id);
    },
    /** Record a successful connection. */
    seen(dev, { ip = "", link = "wifi", now = Date.now() } = {}) {
      const prev = data.devices[dev.id] || { firstSeen: now, count: 0 };
      data.devices[dev.id] = {
        ...prev,
        ...dev,
        lastSeen: now,
        lastIp: clip(ip, 45),
        lastLink: link,
        count: (prev.count || 0) + 1,
      };
      prune();
      save();
      return data.devices[dev.id];
    },
    touch(id, now = Date.now()) {
      if (data.devices[id]) {
        data.devices[id].lastSeen = now;
        save();
      }
    },
    setBlocked(id, on) {
      data.blocked = data.blocked.filter((x) => x !== id);
      if (on) data.blocked.push(id);
      save();
    },
    forget(id) {
      delete data.devices[id];
      data.blocked = data.blocked.filter((x) => x !== id);
      save();
    },
    get(id) {
      return data.devices[id] || null;
    },
    list() {
      return Object.values(data.devices)
        .map((d) => ({ ...d, blocked: data.blocked.includes(d.id) }))
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    },
    log(text, kind = "info", now = Date.now()) {
      log.unshift({ ts: now, kind, text: clip(text, 160) });
      if (log.length > MAX_LOG) log.length = MAX_LOG;
      console.log(`[conn] ${text}`);
    },
    logs() {
      return log.slice();
    },
  };
}

/** How the phone reached us, from the upgrade request. */
export function linkOf(req) {
  const h = req?.headers || {};
  const raw = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (h["cf-connecting-ip"] || h["cf-ray"]) {
    return { link: "internet", ip: String(h["cf-connecting-ip"] || "").split(",")[0].trim() || "internet" };
  }
  if (raw === "127.0.0.1" || raw === "::1") return { link: "usb", ip: raw };
  return { link: "wifi", ip: raw };
}

/** Dashboard + admin API: only the PC itself, never LAN or the tunnel
 * (cloudflared connects from loopback, so its cf-* headers and Host tell). */
export function isLocalRequest(req) {
  const h = req?.headers || {};
  const raw = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (raw !== "127.0.0.1" && raw !== "::1") return false;
  if (h["cf-connecting-ip"] || h["cf-ray"] || h["x-forwarded-for"] || h["cdn-loop"]) return false;
  const host = String(h.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
