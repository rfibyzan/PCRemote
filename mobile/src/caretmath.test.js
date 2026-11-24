// Run: node src/caretmath.test.js
import { fitCanvas, monitorToView } from "./camera.js";
import { caretTarget, followCam, shouldRezoom, textPxFromZoom, zoomForText } from "./caretmath.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log("FAIL", name);
  }
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const VW = 400;
const VH = 200;
const fit = fitCanvas(VW, VH, 16 / 9);
const H20 = 20 / 1080;

ok(caretTarget({ t: "caret", none: true }, 1080) === null, "caretTarget null for none");
ok(caretTarget({ t: "caret", x: 0.5, y: 0.5, h: H20, on: false }, 1080) === null, "caretTarget returns null when off view");
const t = caretTarget({ t: "caret", x: 0.5, y: 0.5, h: H20, on: true }, 1080);
ok(t && t.validH === true && near(t.h, H20), "valid caret");
ok(caretTarget({ t: "caret", x: 0.5, y: 0.5, h: 1 / 1080, on: true }, 1080).validH === false, "1px caret height is not valid");
ok(caretTarget({ t: "caret", x: 0.5, y: 0.5, h: 300 / 1080, on: true }, 1080).validH === false, "huge caret height is not valid");

ok(near(zoomForText(24, H20, fit), 24 / (H20 * fit.bh)), "zoom gives the target text size");
ok(zoomForText(24, 0.0001, fit) === 8, "zoom capped at MAX_ZOOM");
ok(zoomForText(24, 0.5, fit) === 1, "zoom never below 1x");

ok(shouldRezoom(0.02, 0.022) === false, "small height change keeps zoom");
ok(shouldRezoom(0.02, 0.03) === true, "big height change rezooms");
ok(shouldRezoom(null, 0.02) === true, "first caret zooms");

{
  const s = 3;
  const centred = followCam({ s: 1, tx: 0, ty: 0 }, { x: 0.5, y: 0.5, h: H20 }, s, fit, VW, VH);
  ok(centred && near(centred.s, s), "zoom change always moves");
  const still = followCam(centred, { x: 0.52, y: 0.5, h: H20 }, s, fit, VW, VH);
  ok(still === null, "followCam stays inside safe zone");
  const moved = followCam(centred, { x: 0.7, y: 0.5, h: H20 }, s, fit, VW, VH);
  ok(moved !== null, "caret near the edge moves the camera");
  const p = monitorToView(0.7, 0.5 + H20 / 2, moved, fit, VW, VH);
  ok(p.x > 0 && p.x < VW && p.y > 0 && p.y < VH, "caret visible after the move");
}

{
  const s = zoomForText(24, H20, fit); // 6.5x, below the cap
  ok(near(textPxFromZoom(s, H20, fit), 24), "textPxFromZoom inverts zoomForText");
}

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
