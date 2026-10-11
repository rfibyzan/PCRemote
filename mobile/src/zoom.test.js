/**
 * Unit tests for Look-mode zoom math (pure, no RN).
 * Run: node src/zoom.test.js
 */
import { CROP_MATCH_TOL, MAX_ZOOM, MIN_CROP, clampCrop, clampLiveScale, cropMatches, pinchStep, sliderFractionToZoom } from "./zoom.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}  ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const view = { w: 800, h: 400 };
const ident = { s: 1, tx: 0, ty: 0 };

test("clampCrop keeps crop inside monitor and above MIN_CROP", () => {
  const c = clampCrop({ x: 0.95, y: -1, w: 0.01, h: 2 });
  assert(near(c.w, MIN_CROP) && near(c.h, 1), `size ${c.w},${c.h}`);
  assert(near(c.x, 1 - MIN_CROP) && c.y === 0, `pos ${c.x},${c.y}`);
});

test("clampLiveScale bounds total zoom to [1x, MAX_ZOOM]", () => {
  assert(clampLiveScale(0.5, 1) === 1, "no zoom-out past Fit");
  assert(clampLiveScale(100, 1) === MAX_ZOOM, "cap at MAX_ZOOM at Fit");
  assert(near(clampLiveScale(0.1, 0.25), 0.25), "zoom-out down to full monitor from a crop");
  assert(near(clampLiveScale(100, 0.25), MAX_ZOOM * 0.25), "cap relative to monitor, not crop");
});

test("slider maps 1x..MAX_ZOOM", () => {
  assert(sliderFractionToZoom(1) === 1, "bottom = 1x");
  assert(sliderFractionToZoom(0) === MAX_ZOOM, "top = MAX_ZOOM");
  assert(sliderFractionToZoom(-5) === MAX_ZOOM && sliderFractionToZoom(9) === 1, "clamped");
});

test("cropMatches tolerates 1/255 header quantization only", () => {
  const c = { x: 0.3, y: 0.2, w: 0.4, h: 0.4 };
  const q = { x: Math.round(c.x * 255) / 255, y: Math.round(c.y * 255) / 255, w: Math.round(c.w * 255) / 255, h: Math.round(c.h * 255) / 255 };
  assert(cropMatches(q, c), "quantized header matches");
  assert(!cropMatches({ x: 0, y: 0, w: 1, h: 1 }, c), "old full-frame crop does not match");
  assert(!cropMatches({ ...q, x: q.x + CROP_MATCH_TOL * 2 }, c), "a different region does not match");
  assert(!cropMatches(null, c), "missing header crop never matches");
});

test("pinch at centre scales without translation", () => {
  const r = pinchStep({ live: ident, dPrev: 100, d: 200, anchor: { x: 400, y: 200 }, view, cropW: 1 });
  assert(near(r.s, 2) && near(r.tx, 0) && near(r.ty, 0), JSON.stringify(r));
});

test("pinch keeps the content under the finger midpoint fixed", () => {
  const anchor = { x: 600, y: 250 };
  const r = pinchStep({ live: ident, dPrev: 100, d: 150, anchor, view, cropW: 1 });
  // Content point under the anchor before = anchor (identity). After: maps back to anchor.
  const sx = 400 + (anchor.x - 400) * r.s + r.tx;
  const sy = 200 + (anchor.y - 200) * r.s + r.ty;
  assert(near(sx, anchor.x, 1e-6) && near(sy, anchor.y, 1e-6), `${sx},${sy}`);
});

test("pinch is symmetric: in then out returns to identity", () => {
  const a = { x: 300, y: 150 };
  const r1 = pinchStep({ live: ident, dPrev: 100, d: 250, anchor: a, view, cropW: 1 });
  const r2 = pinchStep({ live: r1, dPrev: 250, d: 100, anchor: a, view, cropW: 1 });
  assert(near(r2.s, 1) && near(r2.tx, 0) && near(r2.ty, 0), JSON.stringify(r2));
});

test("pinch never exceeds MAX_ZOOM and never uncovers the view", () => {
  let live = ident;
  for (let i = 0; i < 20; i += 1) live = pinchStep({ live, dPrev: 100, d: 140, anchor: { x: 0, y: 0 }, view, cropW: 1 });
  assert(near(live.s, MAX_ZOOM), `s=${live.s}`);
  const mx = (view.w * live.s - view.w) / 2;
  const my = (view.h * live.s - view.h) / 2;
  assert(Math.abs(live.tx) <= mx + 1e-9 && Math.abs(live.ty) <= my + 1e-9, "translation within cover bounds");
});

test("tiny starting span cannot explode zoom", () => {
  const r = pinchStep({ live: ident, dPrev: 0, d: 0.2, anchor: { x: 400, y: 200 }, view, cropW: 1 });
  assert(near(r.s, 1), `s=${r.s}`);
});

console.log(`\n${passed}/${passed + failed} zoom tests passed`);
if (failed) process.exitCode = 1;
