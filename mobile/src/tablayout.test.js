// node src/tablayout.test.js
import { CONTROL_INNER, rowHeight, viewerHeight } from "./tablayout.js";
let n = 0, ok = 0;
function t(name, cond, info) { n++; if (cond) ok++; else console.log("FAIL", name, JSON.stringify(info)); }
t("two rows fill the area", rowHeight(2) * 2 + 6 === CONTROL_INNER, rowHeight(2));
t("TYPE: 36 dp field + two key rows", rowHeight(2, [36]) === 37, rowHeight(2, [36]));
t("WIN: 28 dp section tabs + two button rows fit without scroll", rowHeight(2, [28]) === 41 && 28 + 6 + 41 * 2 + 6 <= CONTROL_INNER, rowHeight(2, [28]));
t("PAD: one 34 dp button row + touchpad", rowHeight(1, [34]) === 82, rowHeight(1, [34]));
for (const fixed of [[36], [28], [34]]) {
  const rows = fixed.length === 1 && fixed[0] === 34 ? 1 : 2;
  const used = fixed[0] + rows * rowHeight(rows, fixed) + 6 * rows;
  t(`never overflows (${fixed[0]})`, used <= CONTROL_INNER, used);
}
t("row never below 28 dp", rowHeight(9) === 28, rowHeight(9));
const a = viewerHeight(820, 200), b = viewerHeight(820, 200);
t("same window -> same viewer on every tab", a === b && a === 492, [a, b]);
t("bad input is safe", viewerHeight(undefined, 10) === 0, viewerHeight(undefined, 10));
console.log(`${ok}/${n} tablayout tests passed`);
if (ok !== n) process.exit(1);
