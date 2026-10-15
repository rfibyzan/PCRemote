// node src/streamdiag.test.js
import { diagnoseStream, lagStep, lighterQuality } from "./streamdiag.js";
let n = 0, ok = 0;
function t(name, got, want) { n++; if (got === want) ok++; else console.log("FAIL", name, JSON.stringify(got), "!=", want); }
t("on target", diagnoseStream({ target: 19, shown: 17, recv: 18, pc: { sent: 18, same: 0, busy: 0, capMs: 30 } }), "");
t("static", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: { sent: 6, same: 13, busy: 0, capMs: 30 } }), "layar statis");
t("network", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: { sent: 7, same: 0, busy: 12, capMs: 30 } }), "jaringan lambat");
t("pc slow", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: { sent: 7, same: 0, busy: 0, capMs: 120 } }), "PC lambat 120ms");
t("phone decode", diagnoseStream({ target: 19, shown: 6, recv: 18, pc: { sent: 18, same: 0, busy: 0, capMs: 30 } }), "HP lambat decode");
t("old agent, decode", diagnoseStream({ target: 19, shown: 6, recv: 17, pc: null }), "HP lambat decode");
t("old agent, unknown", diagnoseStream({ target: 19, shown: 6, recv: 6, pc: null }), "");
let L = null;
L = lagStep(L, { busy: 3 }); t("1 bad sample: no banner", L.on, false);
L = lagStep(L, { busy: 2 }); t("2 bad samples: banner", L.on, true);
L = lagStep(L, { busy: 0 }); t("1 good: still on", L.on, true);
L = lagStep(L, { busy: 0 }); t("2 good: off", L.on, false);
t("no stats: off", lagStep({ bad: 5, good: 0, on: true }, null).on, false);
const k = (o) => (o ? `${o.q}/${o.qStep}/${o.fpsStep}` : "null");
t("high -> mid", k(lighterQuality({ q: "high", qStep: 0, fpsStep: 0 })), "low/0/0");
t("mid -> low", k(lighterQuality({ q: "low", qStep: 0, fpsStep: 0 })), "lite/0/0");
t("custom up -> base", k(lighterQuality({ q: "high", qStep: 2, fpsStep: 1 })), "high/0/0");
t("low -> lower", k(lighterQuality({ q: "lite", qStep: 0, fpsStep: 0 })), "lite/-1/-2");
t("floor", k(lighterQuality({ q: "lite", qStep: -5, fpsStep: -5 })), "null");
console.log(`${ok}/${n} streamdiag tests passed`);
if (ok !== n) process.exit(1);
