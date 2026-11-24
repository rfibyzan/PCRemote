// node src/filexfer_test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CHUNK, createFileTransfer, safeName, uniquePath } from "./filexfer.js";

let n = 0, ok = 0;
function t(name, cond, info) { n++; if (cond) ok++; else console.log("FAIL", name, JSON.stringify(info)); }

t("path parts stripped", safeName("..\\..\\Windows\\evil.exe") === "evil.exe", safeName("..\\..\\Windows\\evil.exe"));
t("forward slashes too", safeName("a/b/c.txt") === "c.txt");
t("reserved chars replaced", safeName('a:b*c?.txt') === "a_b_c_.txt", safeName('a:b*c?.txt'));
t("device names guarded", safeName("CON.txt") === "_CON.txt");
t("empty gets a name", safeName("   ") === "file");
const taken = new Set([path.join("D", "a.txt"), path.join("D", "a (1).txt")]);
t("unique name", uniquePath("D", "a.txt", (p) => taken.has(p)) === path.join("D", "a (2).txt"));

// Loopback: "pc" sends a real file, "phone" (another instance) receives it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcr-xfer-"));
const src = path.join(tmp, "laporan.bin");
const data = randomBytes(CHUNK * 20 + 1234); // 21 chunks > WINDOW
fs.writeFileSync(src, data);
const inbox = path.join(tmp, "inbox");
const pcWs = { readyState: 1, name: "pc-side" };
const phoneWs = { readyState: 1, name: "phone-side" };
let pc, phone;
// Async delivery like a real socket (never re-entrant).
const deliver = (target, ws, m) => setImmediate(() => target.onMessage(ws, JSON.parse(JSON.stringify(m))));
pc = createFileTransfer({ send: (_ws, m) => deliver(phone, pcWs, m), inbox: () => path.join(tmp, "unused") });
phone = createFileTransfer({ send: (_ws, m) => deliver(pc, phoneWs, m), inbox: () => inbox });
const res = await pc.sendPaths([src, path.join(tmp, "missing.txt")], [phoneWs]);
t("one real file sent, missing one skipped", res.files === 1 && res.ok === 1, res);
const got = fs.readFileSync(path.join(inbox, "laporan.bin"));
t("bytes identical", Buffer.compare(got, data) === 0, got.length);

// Cancel half way: the partial file is removed.
const big = path.join(tmp, "big.bin");
fs.writeFileSync(big, randomBytes(CHUNK * 4));
phone.drop(pcWs);
const half = createFileTransfer({ send: () => {}, inbox: () => inbox });
half.onMessage(pcWs, { t: "fileStart", id: "x", name: "half.bin", size: 100 });
half.onMessage(pcWs, { t: "fileChunk", id: "x", seq: 0, b64: Buffer.alloc(10).toString("base64") });
t("partial exists while receiving", fs.existsSync(path.join(inbox, "half.bin")));
half.drop(pcWs);
t("partial removed when the phone leaves", !fs.existsSync(path.join(inbox, "half.bin")));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${ok}/${n} filexfer tests passed`);
if (ok !== n) process.exit(1);
