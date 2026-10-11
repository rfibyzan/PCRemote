// Run: node src/camera.test.js
import {
  camFor,
  camToNorm,
  clampCam,
  expandRegion,
  fitCanvas,
  monitorToView,
  normToCam,
  pinchCam,
  regionCovers,
  regionFor,
  resolveCrop,
  rubber,
  viewToMonitor,
  visibleRect,
  zoomAt,
} from "./camera.js";

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
const VH = 300;
const fit = fitCanvas(VW, VH, 16 / 9);
const ID = { s: 1, tx: 0, ty: 0 };

ok(near(fit.bw, 400) && near(fit.bh, 225) && near(fit.oy, 37.5), "16:9 monitor fits by width");
const tall = fitCanvas(100, 300, 16 / 9);
ok(near(tall.bw, 100) && near(tall.bh, 56.25), "portrait view fits by width");

// identity: whole monitor visible
const v0 = visibleRect(ID, fit, VW, VH);
ok(near(v0.x, 0) && near(v0.y, 0) && near(v0.w, 1) && near(v0.h, 1), "identity shows whole monitor");

// round trip view <-> monitor
const cam = { s: 3, tx: 50, ty: -20 };
const m = viewToMonitor(123, 77, cam, fit, VW, VH);
const back = monitorToView(m.x, m.y, cam, fit, VW, VH);
ok(near(back.x, 123) && near(back.y, 77), "view<->monitor round trip");

// pinch keeps the focal content under the fingers
const f0 = { x: 100, y: 120 };
const before = viewToMonitor(f0.x, f0.y, ID, fit, VW, VH);
const p = pinchCam(ID, f0, f0, 2.5, VW, VH);
const after = viewToMonitor(f0.x, f0.y, p, fit, VW, VH);
ok(near(before.x, after.x) && near(before.y, after.y), "pinch anchors focal point");
ok(near(p.s, 2.5), "pinch scale");

// moving the focal point pans with the fingers
const p2 = pinchCam(ID, f0, { x: 140, y: 120 }, 2, VW, VH);
const under = viewToMonitor(140, 120, p2, fit, VW, VH);
ok(near(under.x, before.x) && near(under.y, before.y), "focal move pans content with fingers");

// zoom clamps
ok(near(pinchCam(ID, f0, f0, 100, VW, VH).s, 8), "max zoom 8");
ok(near(pinchCam(ID, f0, f0, 0.1, VW, VH).s, 1), "min zoom 1 (Fit)");

// clamp keeps canvas covering the view
const c = clampCam({ s: 2, tx: 9999, ty: -9999 }, fit.bw, fit.bh, VW, VH);
ok(near(c.tx, 200) && near(c.ty, -75), "clampCam limits pan to edges");
const c1 = clampCam({ s: 1, tx: 30, ty: 30 }, fit.bw, fit.bh, VW, VH);
ok(near(c1.tx, 0) && near(c1.ty, 0), "at Fit the canvas is centred");

// rubber band: inside unchanged, outside damped
ok(rubber(10, 50, 400) === 10, "rubber passthrough");
ok(rubber(150, 50, 400) < 100 && rubber(150, 50, 400) > 50, "rubber damps overscroll");
ok(rubber(-150, 50, 400) > -100 && rubber(-150, 50, 400) < -50, "rubber damps negative overscroll");

// camFor / norm round trip
const cf = camFor(4, 0.3, 0.6, fit, VW, VH);
const n = camToNorm(cf, fit, VW, VH);
ok(near(n.z, 4) && near(n.cx, 0.3) && near(n.cy, 0.6), "camFor centres the requested point");
const cf2 = normToCam(n, fit, VW, VH);
ok(near(cf2.tx, cf.tx) && near(cf2.ty, cf.ty), "norm -> cam round trip");
const edge = camToNorm(camFor(2, 0, 0, fit, VW, VH), fit, VW, VH);
ok(edge.cx > 0.24 && edge.cy > 0.0, "camFor clamps at monitor corner");

// visible rect at 2x around centre
const v2 = visibleRect(camFor(2, 0.5, 0.5, fit, VW, VH), fit, VW, VH);
ok(near(v2.w, 0.5) && near(v2.x, 0.25), "2x shows half width");

// zoomAt keeps the point
const z = zoomAt(ID, 2, { x: 300, y: 150 }, VW, VH);
const zp = viewToMonitor(300, 150, z, fit, VW, VH);
const zp0 = viewToMonitor(300, 150, ID, fit, VW, VH);
ok(near(zp.x, zp0.x), "zoomAt anchors tap point");

// regions
const vis = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
const reg = expandRegion(vis, 0.6);
ok(near(reg.w, 0.32) && near(reg.x, 0.34), "expandRegion grows around view");
ok(regionCovers(reg, vis), "region covers its own view");
ok(regionCovers(reg, { x: 0.43, y: 0.42, w: 0.2, h: 0.2 }), "small pan reuses region");
ok(!regionCovers(reg, { x: 0.6, y: 0.4, w: 0.2, h: 0.2 }), "pan past edge needs new region");
ok(!regionCovers(reg, { x: 0.47, y: 0.47, w: 0.05, h: 0.05 }), "zooming in needs sharper region");
ok(!regionCovers(null, vis), "no region -> request");
const full = regionFor({ x: 0, y: 0, w: 0.95, h: 0.96 }, 0.3);
ok(full.w === 1 && full.h === 1, "near Fit asks for whole monitor");
const edgeReg = expandRegion({ x: 0.9, y: 0.0, w: 0.1, h: 0.1 }, 1);
ok(edgeReg.x + edgeReg.w <= 1 + 1e-9 && edgeReg.y >= 0, "region stays inside monitor");

// header crop quantization snaps to exact sent crop
const sent = [{ x: 0.123456, y: 0.2, w: 0.31, h: 0.3 }];
const hdr = { x: Math.round(0.123456 * 255) / 255, y: Math.round(0.2 * 255) / 255, w: Math.round(0.31 * 255) / 255, h: Math.round(0.3 * 255) / 255 };
const r = resolveCrop(hdr, sent);
ok(r.x === 0.123456 && r.w === 0.31, "resolveCrop snaps to exact crop");
const r2 = resolveCrop({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, sent);
ok(r2.x === 0.5, "unknown header used as-is");
ok(resolveCrop(null, sent).w === 1, "missing header = whole monitor");

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
