// node src/streamdiag.test.js
import { diagnoseStream } from "./streamdiag.js";
let n = 0, ok = 0;
function t(name, got, want) { n++; if (got === want) ok++; else console.log("FAIL", name, JSON.stringify(got), "!=", want); }
t("on target", diagnoseStream({ target: 19, shown: 17, recv: 18, pc: { sent: 18, same: 0, busy: 0, capMs: 30 } }), "");
t("static", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: { sent: 6, same: 13, busy: 0, capMs: 30 } }), "layar statis");
t("network", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: { sent: 7, same: 0, busy: 12, capMs: 30 } }), "jaringan lambat");
t("pc slow", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: { sent: 7, same: 0, busy: 0, capMs: 120 } }), "PC lambat 120ms");
t("phone decode", diagnoseStream({ target: 19, shown: 6, recv: 18, pc: { sent: 18, same: 0, busy: 0, capMs: 30 } }), "HP lambat decode");
t("old agent, decode", diagnoseStream({ target: 19, shown: 6, recv: 17, pc: null }), "HP lambat decode");
t("old agent, unknown", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: null }), "");
console.log(`${ok}/${n} streamdiag tests passed`);
if (ok !== n) process.exit(1);
