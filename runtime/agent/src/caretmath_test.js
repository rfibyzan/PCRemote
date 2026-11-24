// Run: node src/caretmath_test.js
import { caretKey, normCaret } from "./caretmath.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log("FAIL", name);
  }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const mon = { left: 0, top: 0, w: 1920, h: 1080 };
const mon2 = { left: 1920, top: 0, w: 1920, h: 1080 };

ok(normCaret(null, mon).none === true, "null rect -> none");
const c = normCaret({ x: 960, y: 540, w: 2, h: 20 }, mon);
ok(near(c.x, 0.5) && near(c.y, 0.5) && near(c.h, 20 / 1080) && c.on === true, "normalises to the monitor");
ok(normCaret({ x: 960, y: 540, w: 2, h: 20 }, mon2).on === false, "caret off this monitor -> on:false");
ok(caretKey(normCaret({ x: 960, y: 540, w: 2, h: 20 }, mon)) === caretKey(normCaret({ x: 960.2, y: 540, w: 2, h: 20 }, mon)), "tiny moves share a key");
ok(caretKey(normCaret({ x: 900, y: 540, w: 2, h: 20 }, mon)) !== caretKey(c), "real moves change the key");
ok(caretKey({ none: true }) === "none", "none key");

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
