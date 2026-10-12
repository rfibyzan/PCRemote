import assert from "node:assert/strict";
import { agoText, newestAnnounce, parseRecent, removeRecent, upsertRecent } from "./recent.js";
import { createConnLog, formatLog } from "./connlog.js";

let n = 0;
const t = (name, fn) => {
  fn();
  n += 1;
};
t("upsert puts newest first and merges", () => {
  let l = upsertRecent([], { code: "AAAABBBB", name: "PC-A", hosts: ["http://1.1.1.1:18765"] }, 1);
  l = upsertRecent(l, { code: "CCCCDDDD", name: "PC-B" }, 2);
  l = upsertRecent(l, { code: "AAAABBBB", name: "PC-A2" }, 3);
  assert.deepEqual(l.map((r) => r.code), ["AAAABBBB", "CCCCDDDD"]);
  assert.equal(l[0].name, "PC-A2");
  assert.deepEqual(l[0].hosts, ["http://1.1.1.1:18765"], "keeps old hosts when none given");
});
t("cap 8", () => {
  let l = [];
  for (let i = 0; i < 12; i += 1) l = upsertRecent(l, { code: `CODE000${i}`.padEnd(8, "X") }, i);
  assert.equal(l.length, 8);
});
t("remove", () => assert.deepEqual(removeRecent([{ code: "AAAABBBB" }, { code: "CCCCDDDD" }], "AAAABBBB"), [{ code: "CCCCDDDD" }]));
t("parse junk", () => {
  assert.deepEqual(parseRecent("nope"), []);
  assert.deepEqual(parseRecent('[{"code":"x"},{"code":"AAAABBBB"}]'), [{ code: "AAAABBBB" }]);
});
t("newest announce wins", () => {
  const b = newestAnnounce([{ ts: 5, tunnel: "old" }, { ts: 9, tunnel: "new" }, null, { ts: 7 }]);
  assert.equal(b.tunnel, "new");
  assert.equal(newestAnnounce([]), null);
});
t("ago", () => {
  assert.equal(agoText(1000, 1000 + 5000), "baru saja");
  assert.equal(agoText(0, 5), "");
  assert.equal(agoText(0 + 1, 1 + 3 * 3600 * 1000), "3 jam lalu");
});
t("conn log dedupe + order", () => {
  const log = createConnLog(3);
  log.add("a", "info", 1000);
  log.add("a", "info", 1200);
  log.add("b", "warn", 2000);
  log.add("c", "info", 3000);
  log.add("d", "error", 4000);
  assert.deepEqual(log.list().map((i) => i.text), ["d", "c", "b"]);
  const txt = formatLog(log.list(), "hdr");
  assert.ok(txt.startsWith("hdr\n"));
  assert.ok(txt.indexOf(" b") < txt.indexOf(" d"), "oldest first");
  assert.ok(txt.includes("ERR "));
});
console.log(`recent + connlog: ${n} tests ok`);
