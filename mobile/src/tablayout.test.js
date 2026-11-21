// node src/tablayout.test.js
import { CONTROL_H, CONTROL_INNER, rowHeight, viewerHeight } from "./tablayout.js";
let n = 0, ok = 0;
function t(name, cond, info) { n++; if (cond) ok++; else console.log("FAIL", name, JSON.stringify(info)); }
t("two rows fill the area", rowHeight(2) * 2 + 6 === CONTROL_INNER, rowHeight(2));
t("TYPE: 44 dp Ketik row + two 38 dp key rows + snippets row", rowHeight(1, [44, 38, 38]) === 32, rowHeight(1, [44, 38, 38]));
t("WIN: 32 dp section tabs + two card rows fit without scroll", rowHeight(2, [32]) === 63 && 32 + 6 + 63 * 2 + 6 <= CONTROL_INNER, rowHeight(2, [32]));
t("PAD: one 48 dp button row + touchpad", rowHeight(1, [48]) === 116, rowHeight(1, [48]));
for (const [fixed, rows] of [[[44, 38, 38], 1], [[32], 2], [[48], 1]]) {
  const used = fixed.reduce((x, y) => x + y, 0) + rows * rowHeight(rows, fixed) + 6 * (fixed.length + rows - 1);
  t(`never overflows (${fixed.join("+")})`, used <= CONTROL_INNER, used);
}
t("row never below 28 dp", rowHeight(9) === 28, rowHeight(9));
const a = viewerHeight(820, 200), b = viewerHeight(820, 200);
t("same window -> same viewer on every tab", a === b && a === 394, [a, b]);
t("Lipat gives the stream the control area", viewerHeight(820, 200, true) - viewerHeight(820, 200) === CONTROL_H, viewerHeight(820, 200, true));
t("bad input is safe", viewerHeight(undefined, 10) === 0, viewerHeight(undefined, 10));
console.log(`${ok}/${n} tablayout tests passed`);
if (ok !== n) process.exit(1);
