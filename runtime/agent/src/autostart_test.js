// Pure-logic tests for autostart.js. No koffi, no Windows: runs anywhere with `node src/autostart_test.js`.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_ENABLED_HEX,
  buildHelperRunCommand,
  buildRunCommand,
  classifyRunValue,
  cscArgs,
  cscCandidates,
  findCsc,
  HELPER_NAME,
  helperNeedsBuild,
  helperPaths,
  buildTaskXml,
  computeAutostart,
  encodeTaskXml,
  exeCandidates,
  findExe,
  parseRegQuery,
  parseStartupApproved,
  parseTaskCommand,
  schtasksPath,
  TASK_NAME,
} from "./autostart.js";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}  ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const EXE = "C:\\Tools\\PC Remote & Co\\PCRemote.exe";

check("task XML: no trigger, highest, battery ok, no limit, ignore new", () => {
  const xml = buildTaskXml({ exePath: EXE, userId: "DESKTOP-RAFI\\rafi" });
  assert(!/<Triggers/i.test(xml), "has no trigger");
  assert(xml.includes("<RunLevel>HighestAvailable</RunLevel>"), "highest run level");
  assert(xml.includes("<LogonType>InteractiveToken</LogonType>"), "interactive");
  assert(xml.includes("<UserId>DESKTOP-RAFI\\rafi</UserId>"), "user id");
  assert(xml.includes("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"), "battery start");
  assert(xml.includes("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"), "battery stop");
  assert(xml.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"), "no time limit");
  assert(xml.includes("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"), "ignore new");
  assert(xml.includes("<Priority>4</Priority>"), "normal priority, not the task default 7");
  assert(xml.includes("<Command>C:\\Tools\\PC Remote &amp; Co\\PCRemote.exe</Command>"), "escaped command");
  assert(xml.includes("<WorkingDirectory>C:\\Tools\\PC Remote &amp; Co</WorkingDirectory>"), "working dir");
  assert(parseTaskCommand(xml) === EXE, "round-trips the command");
});

check("task XML encodes as UTF-16LE with BOM and CRLF", () => {
  const buf = encodeTaskXml("<a>\n</a>");
  assert(buf[0] === 0xff && buf[1] === 0xfe, "BOM");
  assert(buf.subarray(2).toString("utf16le") === "<a>\r\n</a>", "utf16le body");
});

check("Run command quotes schtasks and the task name", () => {
  assert(buildRunCommand() === '"C:\\Windows\\System32\\schtasks.exe" /run /tn "PCRemote"', buildRunCommand());
  assert(schtasksPath({ SystemRoot: "D:\\WIN" }) === "D:\\WIN\\System32\\schtasks.exe", "uses SystemRoot");
  assert(TASK_NAME === "PCRemote", "task name");
});

check("StartupApproved bytes", () => {
  assert(APPROVED_ENABLED_HEX.length === 24 && APPROVED_ENABLED_HEX.startsWith("02"), "12-byte enabled blob");
  assert(!parseStartupApproved("020000000000000000000000").disabled, "02 enabled");
  assert(!parseStartupApproved("060000000000000000000000").disabled, "06 enabled");
  assert(parseStartupApproved("03000000A1B2C3D4E5F60708").disabled, "03 disabled");
  assert(parseStartupApproved("07000000a1b2c3d4e5f60708").disabled, "07 disabled");
  const none = parseStartupApproved("");
  assert(!none.present && !none.disabled, "missing = enabled");
});

check("reg query output parsing", () => {
  const out = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    '    PC Remote    REG_SZ    "C:\\Windows\\System32\\schtasks.exe" /run /tn "PCRemote"',
    "    OneDrive    REG_SZ    C:\\x\\OneDrive.exe /background",
    "",
  ].join("\r\n");
  const v = parseRegQuery(out, "PC Remote");
  assert(v && v.type === "REG_SZ" && v.data.endsWith('/tn "PCRemote"'), JSON.stringify(v));
  const b = parseRegQuery("HKEY_CURRENT_USER\\...\\StartupApproved\\Run\r\n    PC Remote    REG_BINARY    030000000000000000000000\r\n", "PC Remote");
  assert(b && b.type === "REG_BINARY" && parseStartupApproved(b.data).disabled, JSON.stringify(b));
  assert(parseRegQuery(out, "Missing") === null, "missing value");
});

check("computeAutostart combines task + Run + StartupApproved", () => {
  const base = { exePath: EXE, taskExists: true, taskCommand: EXE, runValue: "x", approvedHex: "02" + "00".repeat(11) };
  assert(computeAutostart(base).on === true, "all present = on");
  assert(computeAutostart({ ...base, approvedHex: "" }).on === true, "no approved value = on");
  const tm = computeAutostart({ ...base, approvedHex: "03" + "00".repeat(11) });
  assert(tm.on === false && /Task Manager/.test(tm.reason), "disabled in Task Manager");
  assert(computeAutostart({ ...base, runValue: "" }).on === false, "no Run value = off");
  assert(computeAutostart({ ...base, taskExists: false }).on === false, "no task = off");
  const off = computeAutostart({ exePath: EXE, taskExists: false, runValue: "", approvedHex: "" });
  assert(off.available && !off.on && !off.reason, "clean off");
  assert(computeAutostart({ ...base, taskCommand: "C:\\Old\\PCRemote.exe" }).stale === true, "moved folder flagged stale");
  assert(!computeAutostart({ ...base, taskCommand: EXE.toLowerCase() }).stale, "case-insensitive path match");
  const na = computeAutostart({ exePath: "" });
  assert(na.available === false && na.reason, "no exe = not available");
});

check("exe lookup: PCREMOTE_HOME, then ../../PCRemote.exe", () => {
  const c = exeCandidates({ PCREMOTE_HOME: "/r" }, "/r/runtime/agent");
  // Platform paths: on Windows "/r" resolves to "<drive>:\\r", so compare with path itself.
  const last = path.resolve("/r/runtime/agent", "..", "..", "PCRemote.exe");
  assert(c[0] === path.join("/r", "PCRemote.exe") && c[c.length - 1] === last, JSON.stringify(c));
  assert(findExe({}, () => false) === "", "missing exe");
});

const HELPER = "C:\\Tools\\PC Remote & Co\\runtime\\agent\\autostart\\PCRemoteStart.exe";

check("helper Run command and Run value kinds", () => {
  assert(buildHelperRunCommand(HELPER) === `"${HELPER}"`, buildHelperRunCommand(HELPER));
  assert(classifyRunValue(buildHelperRunCommand(HELPER)) === "helper", "quoted helper");
  assert(classifyRunValue("C:\\x\\pcremotestart.EXE") === "helper", "unquoted, any case");
  assert(classifyRunValue(buildRunCommand()) === "schtasks", "schtasks form");
  assert(classifyRunValue('"D:\\WIN\\System32\\schtasks.exe" /run /tn PCRemote') === "schtasks", "unquoted task name");
  assert(classifyRunValue('"C:\\Windows\\System32\\schtasks.exe" /run /tn "Other"') === "other", "other task");
  assert(classifyRunValue("C:\\x\\Something.exe") === "other", "foreign exe");
  assert(classifyRunValue("") === "" && classifyRunValue(null) === "", "none");
});

check("computeAutostart accepts helper and schtasks Run values", () => {
  const base = { exePath: EXE, taskExists: true, taskCommand: EXE, approvedHex: "" };
  const h = computeAutostart({ ...base, runValue: buildHelperRunCommand(HELPER) });
  assert(h.on && !h.upgrade && !h.reason && !h.note, JSON.stringify(h));
  const s = computeAutostart({ ...base, runValue: buildRunCommand() });
  assert(s.on && s.upgrade === true && !s.reason && !s.note, JSON.stringify(s));
  const n = computeAutostart({ ...base, runValue: buildRunCommand(), helperNote: "Nama di Task Manager: schtasks (csc tidak ada)" });
  assert(n.on && !n.reason && /csc tidak ada/.test(n.note), JSON.stringify(n));
  const nh = computeAutostart({ ...base, runValue: buildHelperRunCommand(HELPER), helperNote: "x" });
  assert(nh.on && !nh.note, "no note when the helper is in use");
  const offNote = computeAutostart({ ...base, taskExists: false, runValue: "", helperNote: "x" });
  assert(!offNote.on && !offNote.note, "no note when off");
  const dis = computeAutostart({ ...base, runValue: buildHelperRunCommand(HELPER), approvedHex: "03" + "00".repeat(11) });
  assert(!dis.on && /Task Manager/.test(dis.reason), "helper entry disabled in Task Manager");
});

check("csc candidates: Framework64 then Framework, from SystemRoot", () => {
  const c = cscCandidates({ SystemRoot: "D:\\WIN" });
  assert(c[0] === "D:\\WIN\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", c[0]);
  assert(c[1] === "D:\\WIN\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe", c[1]);
  assert(cscCandidates({})[0].startsWith("C:\\Windows\\Microsoft.NET\\"), "default root");
  assert(findCsc({ SystemRoot: "D:\\WIN" }, (p) => p === c[1]) === c[1], "32-bit fallback");
  assert(findCsc({ SystemRoot: "D:\\WIN" }, () => false) === "", "no csc");
});

check("helper paths and csc arguments", () => {
  const hp = helperPaths("C:\\PCR\\runtime\\agent", path.win32);
  assert(hp.exe === "C:\\PCR\\runtime\\agent\\autostart\\" + HELPER_NAME, hp.exe);
  assert(hp.src === "C:\\PCR\\runtime\\agent\\autostart\\PCRemoteStart.cs", hp.src);
  assert(hp.ico === "C:\\PCR\\runtime\\agent\\autostart\\PCRemoteStart.ico", hp.ico);
  const a = cscArgs({ src: hp.src, ico: hp.ico, out: hp.exe });
  assert(a.includes("/target:winexe"), "no console window");
  assert(!a.some((x) => /manifest/i.test(x)), "keeps the default asInvoker manifest");
  assert(a.includes(`/out:${hp.exe}`) && a.includes(`/win32icon:${hp.ico}`), JSON.stringify(a));
  assert(a[a.length - 1] === hp.src, "source last");
  assert(!cscArgs({ src: hp.src, ico: "", out: hp.exe }).some((x) => x.startsWith("/win32icon")), "icon optional");
  // The real files sit where helperPaths() says (platform path here).
  const real = helperPaths(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  assert(existsSync(real.src) && existsSync(real.ico), `helper sources missing: ${real.src}`);
});

check("helper rebuild when missing or older than .cs/.ico", () => {
  assert(helperNeedsBuild({ exeMtime: 0, srcMtime: 5, icoMtime: 5 }), "missing exe");
  assert(helperNeedsBuild({ exeMtime: 4, srcMtime: 5, icoMtime: 1 }), "older than source");
  assert(helperNeedsBuild({ exeMtime: 4, srcMtime: 1, icoMtime: 5 }), "older than icon");
  assert(!helperNeedsBuild({ exeMtime: 6, srcMtime: 5, icoMtime: 5 }), "up to date");
  assert(!helperNeedsBuild({ exeMtime: 6, srcMtime: 5 }), "no icon");
});

if (failed) {
  console.log(`autostart: ${failed} failed`);
  process.exit(1);
}
console.log("autostart: ok");
