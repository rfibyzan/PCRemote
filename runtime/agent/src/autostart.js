import { execFile } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Start PC Remote when Windows starts", visible in Task Manager › Startup.
 *
 * PCRemote.exe asks for admin (requireAdministrator), and Windows silently
 * skips elevated programs listed under HKCU\…\Run. So:
 *   1. a Scheduled Task "PCRemote" (no trigger, RunLevel Highest, interactive
 *      token of the current user) launches the exe already elevated, no UAC;
 *   2. HKCU\…\Run "PC Remote" = schtasks.exe /run /tn "PCRemote" fires it at
 *      log-on. That Run value is what Task Manager's Startup tab lists, and
 *      disabling it there writes Explorer\StartupApproved\Run "PC Remote".
 *
 * Pure helpers (exported for autostart_test.js) are platform-independent;
 * the side-effect functions only touch Windows and use execFile (no shell).
 */

export const TASK_NAME = "PCRemote";
export const RUN_VALUE = "PC Remote";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
/** 12-byte StartupApproved blob meaning "enabled" (first byte 0x02, rest zero). */
export const APPROVED_ENABLED_HEX = "02" + "00".repeat(11);

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "..");

function xmlEscape(v) {
  return String(v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
}

/** Task Scheduler XML: no trigger (on demand only), highest privileges,
 * runs on battery, no time limit, a second start while running is ignored. */
export function buildTaskXml({ exePath, userId, workDir }) {
  const dir = workDir || path.win32.dirname(exePath);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>PC Remote: dijalankan saat log-on lewat Startup (HKCU Run "${xmlEscape(RUN_VALUE)}"), tanpa prompt UAC.</Description>
    <URI>\\${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(exePath)}</Command>
      <WorkingDirectory>${xmlEscape(dir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** UTF-16LE with BOM, which schtasks /XML expects for encoding="UTF-16". */
export function encodeTaskXml(xml) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace(/\r?\n/g, "\r\n"), "utf16le")]);
}

export function schtasksPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", "schtasks.exe");
}

export function regPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", "reg.exe");
}

/** The HKCU Run command Task Manager lists. */
export function buildRunCommand(schtasks = "C:\\Windows\\System32\\schtasks.exe") {
  return `"${schtasks}" /run /tn "${TASK_NAME}"`;
}

/** reg.exe prints REG_BINARY as one hex string. A missing value counts as
 * enabled (that is what Explorer does). Bit 0 set (0x03 / 0x07) = disabled. */
export function parseStartupApproved(hex) {
  const clean = String(hex || "").replace(/[^0-9a-f]/gi, "");
  if (clean.length < 2) return { present: false, disabled: false };
  const first = parseInt(clean.slice(0, 2), 16);
  return { present: true, disabled: (first & 1) === 1, first };
}

/** Pull one value's data out of `reg query KEY /v NAME` output. */
export function parseRegQuery(stdout, name) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.match(/^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/) || line.match(/^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s*$/);
    if (m && m[1].trim().toLowerCase() === String(name).toLowerCase()) return { type: m[2], data: (m[3] || "").trim() };
  }
  return null;
}

/** <Command> of `schtasks /Query /XML` output, unescaped and unquoted. */
export function parseTaskCommand(xml) {
  const m = String(xml || "").match(/<Command>([\s\S]*?)<\/Command>/i);
  if (!m) return "";
  return m[1]
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim()
    .replace(/^"(.*)"$/, "$1");
}

function samePath(a, b) {
  return path.win32.normalize(String(a || "")).toLowerCase() === path.win32.normalize(String(b || "")).toLowerCase();
}

/** Combine the probes into what the dashboard shows. "on" needs all three:
 * the task, the Run value, and not switched off in Task Manager. */
export function computeAutostart({ exePath, taskExists, taskCommand, runValue, approvedHex }) {
  if (!exePath) return { available: false, on: false, reason: "PCRemote.exe tidak ditemukan di folder ini" };
  const approved = parseStartupApproved(approvedHex);
  const hasRun = Boolean(runValue);
  const on = Boolean(taskExists) && hasRun && !approved.disabled;
  const out = { available: true, on };
  if (hasRun && approved.disabled) out.reason = "Dimatikan di Task Manager › Startup";
  else if (taskExists && !hasRun) out.reason = "Entri Startup hilang";
  else if (hasRun && !taskExists) out.reason = "Task Scheduler \"PCRemote\" hilang";
  if (on && taskCommand && !samePath(taskCommand, exePath)) out.stale = true;
  return out;
}

/** Where PCRemote.exe sits: launcher sets PCREMOTE_HOME; otherwise the
 * shipped layout <root>\runtime\agent → <root>\PCRemote.exe. */
export function exeCandidates(env = process.env, dir = agentDir) {
  const out = [];
  if (env.PCREMOTE_EXE) out.push(env.PCREMOTE_EXE);
  if (env.PCREMOTE_HOME) out.push(path.join(env.PCREMOTE_HOME, "PCRemote.exe"));
  out.push(path.resolve(dir, "..", "..", "PCRemote.exe"));
  return out;
}

export function findExe(env = process.env, exists = existsSync) {
  return exeCandidates(env).find((p) => exists(p)) || "";
}

// ---------------------------------------------------------------- Windows side

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function currentUserId() {
  const user = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN || "";
  return domain ? `${domain}\\${user}` : user;
}

function failText(r) {
  const t = (r.stderr || r.stdout || "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 200) : `exit ${r.code}`;
}

export async function getAutostart() {
  if (process.platform !== "win32") return { available: false, on: false, reason: "Hanya di Windows" };
  const exePath = findExe();
  if (!exePath) return computeAutostart({ exePath: "" });
  const reg = regPath();
  const [task, runQ, apprQ] = await Promise.all([
    run(schtasksPath(), ["/Query", "/TN", TASK_NAME, "/XML"]),
    run(reg, ["query", RUN_KEY, "/v", RUN_VALUE]),
    run(reg, ["query", APPROVED_KEY, "/v", RUN_VALUE]),
  ]);
  const runVal = runQ.ok ? parseRegQuery(runQ.stdout, RUN_VALUE) : null;
  const appr = apprQ.ok ? parseRegQuery(apprQ.stdout, RUN_VALUE) : null;
  return computeAutostart({
    exePath,
    taskExists: task.ok,
    taskCommand: task.ok ? parseTaskCommand(task.stdout) : "",
    runValue: runVal?.data || "",
    approvedHex: appr?.data || "",
  });
}

export async function setAutostart(on) {
  if (process.platform !== "win32") return { available: false, on: false, reason: "Hanya di Windows" };
  const reg = regPath();
  if (on) {
    const exePath = findExe();
    if (!exePath) return computeAutostart({ exePath: "" });
    const tmp = path.join(os.tmpdir(), `pcremote-task-${process.pid}-${Date.now()}.xml`);
    try {
      writeFileSync(tmp, encodeTaskXml(buildTaskXml({ exePath, userId: currentUserId() })));
      const made = await run(schtasksPath(), ["/Create", "/TN", TASK_NAME, "/XML", tmp, "/F"]);
      if (!made.ok) throw new Error(`Task Scheduler: ${failText(made)}`);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // temp file already gone
      }
    }
    const runSet = await run(reg, ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", buildRunCommand(schtasksPath()), "/f"]);
    if (!runSet.ok) throw new Error(`Registry Run: ${failText(runSet)}`);
    const appr = await run(reg, ["add", APPROVED_KEY, "/v", RUN_VALUE, "/t", "REG_BINARY", "/d", APPROVED_ENABLED_HEX, "/f"]);
    if (!appr.ok) throw new Error(`StartupApproved: ${failText(appr)}`);
  } else {
    // Missing values are fine here; only a task that exists but will not go is an error.
    await run(reg, ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    await run(reg, ["delete", APPROVED_KEY, "/v", RUN_VALUE, "/f"]);
    const exists = await run(schtasksPath(), ["/Query", "/TN", TASK_NAME]);
    if (exists.ok) {
      const del = await run(schtasksPath(), ["/Delete", "/TN", TASK_NAME, "/F"]);
      if (!del.ok) throw new Error(`Task Scheduler: ${failText(del)}`);
    }
  }
  return getAutostart();
}

/** Cached view for apiState() (polled every 2 s): re-probe at most every
 * few seconds in the background so a switch-off in Task Manager shows up. */
export function createAutostartCache(maxAgeMs = 5000) {
  let value = process.platform === "win32" ? { available: false, on: false, reason: "Memeriksa…" } : { available: false, on: false, reason: "Hanya di Windows" };
  let at = 0;
  let busy = null;
  const refresh = () => {
    if (busy) return busy;
    busy = getAutostart()
      .then((v) => {
        value = v;
        at = Date.now();
        return v;
      })
      .catch(() => value)
      .finally(() => {
        busy = null;
      });
    return busy;
  };
  return {
    get() {
      if (process.platform === "win32" && Date.now() - at > maxAgeMs) void refresh();
      const { stale, ...pub } = value;
      return pub;
    },
    raw: () => value,
    refresh,
    set(v) {
      value = v;
      at = Date.now();
    },
  };
}
