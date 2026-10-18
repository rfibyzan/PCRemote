/**
 * One-click update for release installs (dashboard "Perbarui sekarang").
 *
 *   1. download the release zip (updates.js pickUpdateAsset) to %TEMP%
 *   2. unpack it with PowerShell Expand-Archive and check it (index.js +
 *      version.txt = the tag we asked for)
 *   3. start update/apply-update.ps1 detached and exit with code 0, so the
 *      launcher / start.bat close; the script swaps the files with nothing
 *      running, rolls back on any error and starts PC Remote again.
 *
 * Only the agent folder and PCRemote.exe are replaced; settings, pairing and
 * devices live in %APPDATA%\PCRemote. A git checkout has no version.txt and
 * never offers this (update it with git pull).
 */
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = path.resolve(here, "..");
export const APPLY_SCRIPT = path.join(AGENT_DIR, "update", "apply-update.ps1");

/** Folder PCRemote.exe sits in: launcher's PCREMOTE_HOME, else ../.. of the agent. */
export function installRoot(env = process.env, agentDir = AGENT_DIR) {
  return env.PCREMOTE_HOME ? path.resolve(env.PCREMOTE_HOME) : path.resolve(agentDir, "..", "..");
}

/** How to start PC Remote again: the launcher sets PCREMOTE_LAUNCHER=1. */
export function relaunchMode(env = process.env) {
  return env.PCREMOTE_LAUNCHER === "1" ? "exe" : "bat";
}

/** The unpacked folder that holds runtime/agent/src/index.js: the zip's
 * top "PCRemote" folder, or the extract dir itself. null when missing. */
export function findStagedRoot(dir, exists = existsSync, list = (d) => readdirSync(d)) {
  const has = (d) => exists(path.join(d, "runtime", "agent", "src", "index.js"));
  if (has(dir)) return dir;
  let names = [];
  try {
    names = list(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    const d = path.join(dir, n);
    if (has(d)) return d;
  }
  return null;
}

/** Progress text for the dashboard. */
export function progressText(p) {
  if (!p) return "";
  if (p.phase === "download") {
    const mb = (n) => (n / 1048576).toFixed(1);
    return p.total ? `Mengunduh ${Math.floor((p.done / p.total) * 100)}% (${mb(p.done)} / ${mb(p.total)} MB)` : `Mengunduh ${mb(p.done)} MB`;
  }
  if (p.phase === "extract") return "Membuka paket…";
  if (p.phase === "apply") return "Memasang, PC Remote akan mulai ulang…";
  if (p.phase === "error") return `Gagal: ${p.error}`;
  return "";
}

function runPowershell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/)[0] || `PowerShell ${code}`))));
  });
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Download + unpack + hand over. `onProgress({phase, done, total})`.
 * Resolves with {root, stage, script} once apply-update.ps1 is running; the
 * caller then exits the agent with code 0. Throws with a readable message.
 */
export async function downloadAndStage(update, { onProgress = () => {}, fetchImpl = fetch } = {}) {
  if (process.platform !== "win32") throw new Error("Hanya untuk Windows");
  const asset = update?.asset;
  if (!asset?.url) throw new Error("Rilis ini tidak punya paket Windows");
  if (!existsSync(APPLY_SCRIPT)) throw new Error("apply-update.ps1 tidak ditemukan");

  const work = path.join(tmpdir(), `PCRemote-update-${String(update.tag).replace(/[^\w.-]/g, "")}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const zip = path.join(work, "update.zip");
  const out = path.join(work, "files");

  // 1. download
  const res = await fetchImpl(asset.url, { headers: { "User-Agent": "pcremote-agent" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Unduhan gagal (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  let done = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    done += c.length;
    const now = Date.now();
    if (now - last > 250) {
      last = now;
      onProgress({ phase: "download", done, total });
    }
  });
  await pipeline(body, createWriteStream(zip));
  if (total && statSync(zip).size !== total) throw new Error("Unduhan tidak lengkap");
  onProgress({ phase: "download", done: total || done, total: total || done });

  // 2. unpack + check
  onProgress({ phase: "extract" });
  await runPowershell(["-Command", `Expand-Archive -LiteralPath ${psq(zip)} -DestinationPath ${psq(out)} -Force`]);
  rmSync(zip, { force: true });
  const stage = findStagedRoot(out);
  if (!stage) throw new Error("Paket pembaruan tidak berisi runtime\\agent");
  let staged = "";
  try {
    staged = readFileSync(path.join(stage, "runtime", "agent", "version.txt"), "utf8").trim();
  } catch {
    // checked below
  }
  if (staged !== update.tag) throw new Error(`Versi paket (${staged || "?"}) tidak sama dengan ${update.tag}`);

  // 3. hand over to the script (a copy outside the folder it replaces)
  onProgress({ phase: "apply" });
  const script = path.join(work, "apply-update.ps1");
  copyFileSync(APPLY_SCRIPT, script);
  const root = installRoot();
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-Root",
      root,
      "-Stage",
      stage,
      "-AgentPid",
      String(process.pid),
      "-Tag",
      String(update.tag),
      "-Relaunch",
      relaunchMode(),
    ],
    { detached: true, windowsHide: true, stdio: "ignore", cwd: work },
  );
  child.unref();
  return { root, stage, script };
}

/** Result the script left for the next start: {tag, ok, at} or null. Read once. */
export function takeUpdateResult(env = process.env) {
  const file = path.join(env.APPDATA || path.join(tmpdir(), ".."), "PCRemote", "update-result.json");
  try {
    const r = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    rmSync(file, { force: true });
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}
