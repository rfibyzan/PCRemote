import { spawn, execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tunnelBackoffMs } from "./keepalive.js";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");

function bundledCloudflaredPaths() {
  const names = ["cloudflared.exe", "cloudflared"];
  const dirs = [
    process.env.PCREMOTE_HOME,
    process.env.PCREMOTE_RUNTIME,
    process.cwd(),
    agentRoot,
    join(agentRoot, ".."),
    dirname(process.execPath),
    join(dirname(process.execPath), ".."),
  ].filter(Boolean);
  const out = [];
  for (const dir of dirs) {
    for (const name of names) out.push(join(dir, name));
  }
  return out;
}

const CANDIDATES = [
  ...bundledCloudflaredPaths(),
  "cloudflared",
  "cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
];

function isExeFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findBinary() {
  for (const candidate of CANDIDATES) {
    if (candidate.endsWith(".exe") && isExeFile(candidate)) return candidate;
    if (!candidate.endsWith(".exe") && candidate.includes("\\") && isExeFile(candidate)) return candidate;
    if (!candidate.endsWith(".exe") && candidate.includes("/") && isExeFile(candidate)) return candidate;
  }
  try {
    const found = execSync("where cloudflared", { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found && isExeFile(found)) return found;
  } catch {
    // not on PATH
  }
  return "cloudflared";
}

/** cloudflared is no longer bundled in the release zip (-52 MB): fetched once on first start. */
export const CLOUDFLARED_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

/** Where a downloaded cloudflared.exe lives: next to node.exe (runtime/). */
export function downloadTarget() {
  const dir = process.env.PCREMOTE_RUNTIME || join(agentRoot, "..");
  return join(dir, "cloudflared.exe");
}

let downloading = null;
/** Download cloudflared.exe to runtime/ once; resolves to its path or "" on failure. */
export function downloadCloudflared(target = downloadTarget(), url = CLOUDFLARED_URL) {
  if (downloading) return downloading;
  downloading = (async () => {
    const tmp = `${target}.part`;
    try {
      mkdirSync(dirname(target), { recursive: true });
      console.log("cloudflared belum ada, mengunduh sekali (~50 MB)...");
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      if (statSync(tmp).size < 5_000_000) throw new Error("file terlalu kecil");
      renameSync(tmp, target);
      console.log(`cloudflared terunduh: ${target}`);
      return target;
    } catch (err) {
      console.warn("unduh cloudflared gagal:", err.message);
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      return "";
    } finally {
      downloading = null;
    }
  })();
  return downloading;
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
}

function spawnTunnel(bin, port, onUrl) {
  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let found = "";
  const handle = (buf) => {
    const text = buf.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && match[0] !== found) {
      found = match[0];
      onUrl(found.replace(/^https:/i, "wss:"));
    }
  };
  child.stdout.on("data", handle);
  child.stderr.on("data", handle);
  child.on("error", (err) => {
    console.warn("cloudflared not started:", err.message);
  });
  return child;
}

export function superviseTunnel(port, onUrl) {
  let bin = findBinary();
  let child = null;
  let stopped = false;
  let delay = 2000;
  let spawnedAt = 0;

  function spawnOnce() {
    if (stopped || child) return;
    if (bin === "cloudflared" && process.platform === "win32") {
      // Not bundled and not installed: fetch it, then try again.
      spawnedAt = Date.now();
      downloadCloudflared().then((path) => {
        if (path) bin = path;
        else {
          const wait = delay;
          delay = tunnelBackoffMs(delay);
          setTimeout(spawnOnce, wait);
          return;
        }
        spawnOnce();
      });
      return;
    }
    spawnedAt = Date.now();
    child = spawnTunnel(bin, port, (url) => {
      delay = 2000;
      onUrl(url);
    });
    child.on("exit", () => {
      child = null;
      onUrl("");
      if (stopped) return;
      console.warn(`cloudflared exited; retrying in ${Math.round(delay / 1000)}s`);
      const wait = delay;
      delay = tunnelBackoffMs(delay);
      setTimeout(spawnOnce, wait);
    });
  }

  function restart() {
    if (stopped) return;
    delay = 2000;
    if (child?.pid) {
      killProcessTree(child.pid);
      return;
    }
    spawnOnce();
  }

  spawnOnce();
  return {
    restart,
    running: () => Boolean(child && child.exitCode == null),
    hung: (ms = 90_000) => Boolean(child && Date.now() - spawnedAt > ms),
    stop() {
      stopped = true;
      if (child?.pid) killProcessTree(child.pid);
    },
  };
}
