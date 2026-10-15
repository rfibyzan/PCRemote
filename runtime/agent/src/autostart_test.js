// Pure-logic tests for autostart.js. No koffi, no Windows: runs anywhere with `node src/autostart_test.js`.
import {
  APPROVED_ENABLED_HEX,
  buildRunCommand,
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
  assert(c[0].endsWith("PCRemote.exe") && c[c.length - 1] === "/r/PCRemote.exe", JSON.stringify(c));
  assert(findExe({}, () => false) === "", "missing exe");
});

if (failed) {
  console.log(`autostart: ${failed} failed`);
  process.exit(1);
}
console.log("autostart: ok");
