// node src/fonts/pick.test.js
import { pickFamily } from "./pick.js";
const S = { regular: "R", medium: "M", bold: "B" };
const cases = [
  [null, "800", null], [S, undefined, "R"], [S, "normal", "R"], [S, "400", "R"], [S, "300", "R"],
  [S, "500", "M"], [S, "600", "M"], [S, "700", "B"], [S, "800", "B"], [S, "900", "B"], [S, "bold", "B"], [S, 600, "M"],
];
let ok = 0;
for (const [set, w, want] of cases) {
  const got = pickFamily(set, w);
  if (got === want) ok += 1;
  else console.log("FAIL", w, got, "!=", want);
}
console.log(`${ok}/${cases.length} ok`);
if (ok !== cases.length) process.exit(1);
