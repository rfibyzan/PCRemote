/**
 * Unit tests for the GAME layout model + multi-touch router (pure, no RN).
 * Run: node src/game/layout.test.js
 */
import { CONTROL_DEFS, CONTROL_IDS, cleanLayout, controlBox, defaultLayout, dpadDirs, faceButton, hitTest, moveControl, stickVector } from "./layout.js";
import { TouchRouter } from "./router.js";

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
function assert(c, m) {
  if (!c) throw new Error(m);
}

// Common landscape phone sizes (dp).
const SCREENS = [
  [640, 360],
  [780, 360],
  [915, 412],
  [1024, 600],
];

function fakePad() {
  const p = { btn: {}, sticks: { left: [0, 0], right: [0, 0] }, trig: { left: 0, right: 0 } };
  p.setButton = (n, d) => (p.btn[n] = d);
  p.setStick = (w, x, y) => (p.sticks[w] = [x, y]);
  p.setTrigger = (w, v) => (p.trig[w] = v);
  return p;
}
function makeRouter(W = 780, H = 360, layout = defaultLayout()) {
  const pad = fakePad();
  let t = 0;
  const r = new TouchRouter({ pad, getLayout: () => layout, getSize: () => ({ W, H }), now: () => t });
  return { r, pad, layout, W, H, tick: (ms) => (t += ms) };
}
const box = (L, id, W, H) => controlBox(L, id, W, H);

test("default layout: every visible control fully on screen", () => {
  const L = defaultLayout();
  for (const [W, H] of SCREENS) {
    for (const id of CONTROL_IDS) {
      const b = box(L, id, W, H);
      assert(b.left >= 0 && b.top >= 0 && b.left + b.w <= W + 0.01 && b.top + b.h <= H + 0.01, `${id} off-screen at ${W}x${H}`);
    }
  }
});

test("default layout: visible controls do not overlap", () => {
  const L = defaultLayout();
  const ids = CONTROL_IDS.filter((id) => L.controls[id].visible);
  for (const [W, H] of SCREENS) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = box(L, ids[i], W, H);
        const b = box(L, ids[j], W, H);
        const round = (id) => ["stick", "dpad", "face", "small"].includes(CONTROL_DEFS[id].kind);
        const ov = round(ids[i]) && round(ids[j])
          ? Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.w / 2 + b.w / 2
          : a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;
        assert(!ov, `${ids[i]} overlaps ${ids[j]} at ${W}x${H}`);
      }
    }
  }
});

test("hitTest finds each visible control at its centre", () => {
  const L = defaultLayout();
  for (const [W, H] of SCREENS) {
    for (const id of CONTROL_IDS) {
      if (!L.controls[id].visible) continue;
      const b = box(L, id, W, H);
      assert(hitTest(L, W, H, b.cx, b.cy) === id, `${id} at ${W}x${H}`);
    }
  }
  assert(hitTest(L, 780, 360, 390, 150) === null, "empty middle is free");
});

test("hidden controls are not hittable", () => {
  const L = defaultLayout();
  const b = box(L, "l3", 780, 360);
  assert(hitTest(L, 780, 360, b.cx, b.cy) !== "l3", "l3 hidden by default");
});

test("cleanLayout rejects junk and clamps values", () => {
  const L = cleanLayout({ version: 2, opacity: 9, scale: -1, controls: { face: { x: 5, y: -2, size: 99, opacity: 0 } } });
  assert(L.opacity === 1 && L.scale === 0.6, "settings clamped");
  assert(L.controls.face.x === 1 && L.controls.face.y === 0 && L.controls.face.size === 2 && L.controls.face.opacity === 0.1, "control clamped");
  assert(cleanLayout({ version: 1, foo: 1 }).controls.stickL.x === defaultLayout().controls.stickL.x, "old version -> defaults");
});

test("moveControl keeps control on screen", () => {
  const L = moveControl(defaultLayout(), "face", 5000, -100, 780, 360);
  const b = box(L, "face", 780, 360);
  assert(b.left + b.w <= 780.01 && b.top >= 0, "clamped");
});

test("stickVector: +y up, unit clamped", () => {
  const v = stickVector(100, 100, 50, 100, 0);
  assert(v.x === 0 && v.y === 1, JSON.stringify(v));
  const d = stickVector(0, 0, 10, 30, 40);
  assert(Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-9, "clamped");
});

test("dpad: 8-way with diagonals and dead centre", () => {
  const up = dpadDirs(0, 0, 100, 0, -40);
  assert(up.up && !up.left && !up.right && !up.down, "up");
  const ur = dpadDirs(0, 0, 100, 30, -30);
  assert(ur.up && ur.right && !ur.left && !ur.down, "up-right");
  const left = dpadDirs(0, 0, 100, -40, 18); // ~24 deg below the left arm axis
  assert(left.left && !left.down && !left.up, "left arm stays pure left");
  const c = dpadDirs(0, 0, 100, 2, 2);
  assert(!c.up && !c.down && !c.left && !c.right, "centre");
});

test("face: diamond quadrants", () => {
  assert(faceButton(0, 0, 0, -10) === "y" && faceButton(0, 0, 0, 10) === "a", "y/a");
  assert(faceButton(0, 0, -10, 0) === "x" && faceButton(0, 0, 10, 0) === "b", "x/b");
});

test("router: both sticks at once, independently", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const L = box(layout, "stickL", W, H);
  const R = box(layout, "stickR", W, H);
  r.start(1, L.cx, L.cy);
  r.start(2, R.cx, R.cy);
  r.move(1, L.cx + 200, L.cy);
  r.move(2, R.cx, R.cy - 200);
  assert(pad.sticks.left[0] === 1 && pad.sticks.right[1] === 1, JSON.stringify(pad.sticks));
  r.end(1);
  assert(pad.sticks.left[0] === 0 && pad.sticks.right[1] === 1, "left released, right still held");
});

test("router: stick + face + trigger + bumper together", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const S = box(layout, "stickL", W, H);
  const F = box(layout, "face", W, H);
  const T = box(layout, "rt", W, H);
  const B = box(layout, "lb", W, H);
  r.start(1, S.cx, S.cy);
  r.start(2, F.cx, F.cy + F.h * 0.35);
  r.start(3, T.cx, T.cy);
  r.start(4, B.cx, B.cy);
  assert(pad.btn.a && pad.trig.right === 1 && pad.btn.lb, JSON.stringify(pad));
  r.end(2);
  assert(!pad.btn.a && pad.trig.right === 1 && pad.btn.lb, "only A released");
});

test("router: sliding across ABXY rolls buttons", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const F = box(layout, "face", W, H);
  r.start(1, F.cx, F.cy + F.h * 0.35);
  assert(pad.btn.a, "A");
  r.move(1, F.cx + F.w * 0.35, F.cy);
  assert(!pad.btn.a && pad.btn.b, "slid to B");
});

test("router: finger keeps its stick when sliding off it", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const S = box(layout, "stickL", W, H);
  r.start(1, S.cx, S.cy);
  r.move(1, W / 2, S.cy);
  assert(pad.sticks.left[0] === 1, "still steering");
});

test("router: fixed stick touched slightly off-centre does not drift", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const S = box(layout, "stickL", W, H);
  r.start(1, S.cx + 6, S.cy + 6);
  assert(pad.sticks.left[0] === 0 && pad.sticks.left[1] === 0, JSON.stringify(pad.sticks.left));
  r.move(1, S.cx + 400, S.cy + 6);
  assert(pad.sticks.left[0] === 1, "full right");
});

test("router: second thumb on a held stick is ignored", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const S = box(layout, "stickL", W, H);
  r.start(1, S.cx, S.cy);
  assert(r.start(2, S.cx, S.cy) === null, "rejected");
  r.end(2);
  r.move(1, S.cx + 200, S.cy);
  assert(pad.sticks.left[0] === 1, "owner unaffected");
});

test("router: double-tap-and-hold stick = L3", () => {
  const { r, pad, layout, W, H, tick } = makeRouter();
  const S = box(layout, "stickL", W, H);
  r.start(1, S.cx, S.cy);
  r.end(1);
  tick(150);
  r.start(2, S.cx, S.cy);
  assert(pad.btn.l3, "L3 held");
  r.end(2);
  assert(!pad.btn.l3, "L3 released");
  tick(1000);
  r.start(3, S.cx, S.cy);
  assert(!pad.btn.l3, "slow re-touch is not a click");
});

test("router: floating stick centres on first touch", () => {
  const L = { ...defaultLayout(), stickMode: "floating" };
  const { r, pad, W, H } = makeRouter(780, 360, L);
  const S = box(L, "stickL", W, H);
  r.start(1, S.cx + 40, S.cy + 20);
  assert(pad.sticks.left[0] === 0 && pad.sticks.left[1] === 0, "no jump on touch-down");
  r.move(1, S.cx + 240, S.cy + 20);
  assert(pad.sticks.left[0] === 1, "relative to touch-down point");
});

test("router: same button held by two fingers stays down until both lift", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const D = box(layout, "dpad", W, H);
  r.start(1, D.cx, D.cy - D.h * 0.4);
  r.start(2, D.cx + 5, D.cy - D.h * 0.38);
  r.end(1);
  assert(pad.btn.up, "still held by finger 2");
  r.end(2);
  assert(!pad.btn.up, "released");
});

test("router: sync releases fingers whose touchEnd was lost; reused id resets", () => {
  const { r, pad, layout, W, H } = makeRouter();
  const B = box(layout, "rb", W, H);
  const F = box(layout, "face", W, H);
  r.start(7, B.cx, B.cy);
  r.sync([]);
  assert(!pad.btn.rb, "rb released by sync");
  r.start(1, F.cx, F.cy - F.h * 0.35);
  r.start(1, B.cx, B.cy);
  assert(!pad.btn.y && pad.btn.rb, "pointer id reuse dropped Y");
  r.releaseAll();
  assert(!pad.btn.rb && r.fingers.size === 0, "all released");
});

console.log(`\n${passed}/${passed + failed} layout tests passed`);
if (failed) process.exitCode = 1;
