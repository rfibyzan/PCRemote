import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateCode, normalizeCode } from "./crypto.js";

export const DEFAULT_PORT = 18765;
export const PORT_RANGE = 10;

export function lockPath() {
  if (process.env.PCREMOTE_LOCK) return process.env.PCREMOTE_LOCK;
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "PCRemote", "lock.json");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pcremote", "lock.json");
}

function writeLock(lock) {
  const file = lockPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ code: lock.code, created: lock.created }, null, 2)}\n`);
  return lock;
}

export function loadLock() {
  try {
    const raw = JSON.parse(readFileSync(lockPath(), "utf8"));
    const code = normalizeCode(raw.code);
    if (code.length >= 8) return { code, created: Number(raw.created) || Date.now() };
  } catch {
    // first run
  }
  return writeLock({ code: generateCode(), created: Date.now() });
}

export function revokeLock() {
  return writeLock({ code: generateCode(), created: Date.now() });
}

export function displayCode(code) {
  const n = normalizeCode(code);
  return n.length === 8 ? `${n.slice(0, 4)} ${n.slice(4)}` : n;
}

export async function findExistingAgent(preferred = DEFAULT_PORT) {
  for (let port = preferred; port < preferred + PORT_RANGE; port += 1) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 600);
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.ok && Array.isArray(json.monitors)) return { port, health: json };
    } catch {
      // empty slot
    }
  }
  return null;
}

export function listenOnFreePort(server, preferred = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    let port = preferred;
    const attempt = () => {
      const onErr = (err) => {
        server.off("listening", onOk);
        if (err.code === "EADDRINUSE" && port < preferred + PORT_RANGE - 1) {
          port += 1;
          attempt();
          return;
        }
        reject(err);
      };
      const onOk = () => {
        server.off("error", onErr);
        resolve(port);
      };
      server.once("error", onErr);
      server.once("listening", onOk);
      server.listen(port, "0.0.0.0");
    };
    attempt();
  });
}
