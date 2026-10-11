// node src/tablayout.test.js
import { viewerBox } from "./tablayout.js";
let n = 0, ok = 0;
function t(name, cond, info) { n++; if (cond) ok++; else console.log("FAIL", name, JSON.stringify(info)); }
const a = viewerBox(392, 850);
t("16:9 on a normal phone", a.width === 376 && a.height === 212, a);
const b = viewerBox(392, 500);
t("capped at 40% of a short window", b.height === 200, b);
const c = viewerBox(320, 300);
t("never below minimum", c.height === 160, c);
const d1 = viewerBox(392, 850), d2 = viewerBox(392, 850);
t("same window -> same box (tab-independent)", d1.height === d2.height && d1.width === d2.width, [d1, d2]);
const e = viewerBox(800, 1280);
t("tablet", e.width === 784 && e.height === 441, e);
console.log(`${ok}/${n} tablayout tests passed`);
if (ok !== n) process.exit(1);
