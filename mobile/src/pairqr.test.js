import assert from "node:assert/strict";
import { formatCodeInput, fromParams, parsePairQr } from "./pairqr.js";

let n = 0;
const t = (name, fn) => {
  fn();
  n += 1;
};
t("full uri", () => {
  const r = parsePairQr("pcremote://pair?c=ZCJGS4E5&h=192.168.1.5%3A8765%2C10.0.0.2%3A8765");
  assert.equal(r.code, "ZCJGS4E5");
  assert.deepEqual(r.hosts, [{ host: "192.168.1.5", port: 8765 }, { host: "10.0.0.2", port: 8765 }]);
});
t("no hosts", () => assert.deepEqual(parsePairQr("pcremote://pair?c=zcjg-s4e5"), { code: "ZCJGS4E5", hosts: [] }));
t("bad code", () => assert.equal(parsePairQr("pcremote://pair?c=ABC"), null));
t("bare code", () => assert.equal(parsePairQr("ZCJG S4E5").code, "ZCJGS4E5"));
t("junk", () => {
  assert.equal(parsePairQr("https://example.com"), null);
  assert.equal(parsePairQr(""), null);
});
t("junk hosts dropped", () => assert.deepEqual(fromParams({ c: "ZCJGS4E5", h: "x;rm,1.2.3.4:99999x,1.2.3.4:80" }).hosts, [{ host: "1.2.3.4", port: 80 }]));
t("format", () => {
  assert.equal(formatCodeInput("zcjg"), "ZCJG");
  assert.equal(formatCodeInput("zcjgs4"), "ZCJG S4");
  assert.equal(formatCodeInput("ZCJG S4E5X"), "ZCJG S4E5");
});
console.log(`pairqr: ${n} tests ok`);
