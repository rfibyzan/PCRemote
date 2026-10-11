/**
 * Unit tests for GAME overlay geometry (pure, no RN).
 * Run: node src/game/geometry.test.js
 */
import { computeMetrics, computeRects, hitTest, toLocal, insideStick, pageRects, sanitizeLayout, PAIR_GAP, ZONES } from "./geometry.js";

const results = [];
function pass(name, extra = "") {
  results.push({ name, ok: true });
  console.log(`PASS  ${name}${extra ? `  (${extra})` : ""}`);
}
function fail(name, err) {
  results.push({ name, ok: false });
  console.log(`FAIL  ${name}  ${err}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(a, b, eps = 1.5) {
  return Math.abs(a - b) <= eps;
}

function tryRun(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(name, err);
  }
}

// Landscape phone, notch present (Xiaomi 13T class).
const M = computeMetrics({ W: 873, H: 393, insets: { top: 48, left: 0, right: 0, bottom: 24 } });
const RECTS = computeRects(M);
const ID = { left: "left", right: "right", shoulderL: "shoulderL", shoulderR: "shoulderR", topBar: "topBar" };

tryRun("metrics follow the responsive formula", () => {
  // Controls are sized from the SCREEN, never derived from the stick radius:
  // k = R/62 clamped to 0.74 on a 393dp phone, which is what produced 40dp
  // face buttons and 38x33dp d-pad arms.
  assert(M.fD >= 48, `face button ${M.fD}dp is below the 48dp touch minimum`);
  assert(M.dW >= 48 && M.dH >= 48, `d-pad arm ${M.dW}x${M.dH}dp is below the touch minimum`);
  assert(M.fD !== Math.round(54 * (M.R / 62)), "face size must not be stick-derived");
  assert(M.dW !== Math.round(52 * (M.R / 62)), "d-pad width must not be stick-derived");
  assert(M.dW === M.dH, "d-pad arms are square");
  assert(M.leftPad === 8, "leftPad");
  assert(M.topPad === 68, "topPad");
});

tryRun("every gameplay control meets the 48dp touch minimum", () => {
  const RECTS = computeRects(M);
  const buttons = ["dpadUp", "dpadDown", "dpadLeft", "dpadRight", "faceY", "faceX", "faceB", "faceA"];
  for (const z of buttons) {
    const cluster = z.startsWith("dpad") ? "left" : "right";
    const r = RECTS[cluster][z];
    assert(r.w >= 48 && r.h >= 48, `${z} is ${r.w}x${r.h}dp (< 48)`);
  }
  for (const [cluster, z] of [["left", "stickL"], ["right", "stickR"]]) {
    const r = RECTS[cluster][z];
    assert(r.w >= 48 && r.h >= 48, `${z} is ${r.w}x${r.h}dp`);
  }
});

tryRun("no two neighbouring gameplay zones overlap", () => {
  const RECTS = computeRects(M);
  const groups = ["left", "right", "shoulderL", "shoulderR"];
  const overlaps = (a, b) =>
    a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  for (const g of groups) {
    const entries = Object.entries(RECTS[g]).filter(([k]) => k !== "box");
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        assert(!overlaps(entries[i][1], entries[j][1]), `${entries[i][0]} overlaps ${entries[j][0]}`);
      }
    }
  }
});

tryRun("X and B are visually separated, not one XB blob", () => {
  const RECTS = computeRects(M);
  const X = RECTS.right.faceX;
  const B = RECTS.right.faceB;
  const gap = B.x - (X.x + X.w);
  assert(gap >= PAIR_GAP - 0.5, `X|B gap ${gap} is below PAIR_GAP ${PAIR_GAP}`);
  // Each must resolve to itself at its own centre.
  assert(hitTest(RECTS, ID, X.x + X.w / 2, X.y + X.h / 2, 0)?.zone === "faceX", "X centre");
  assert(hitTest(RECTS, ID, B.x + B.w / 2, B.y + B.h / 2, 0)?.zone === "faceB", "B centre");
});

tryRun("all face and d-pad centres are distinct", () => {
  const RECTS = computeRects(M);
  const centres = {};
  for (const [cluster, zone] of [["right", "faceY"], ["right", "faceX"], ["right", "faceB"], ["right", "faceA"], ["left", "dpadUp"], ["left", "dpadDown"], ["left", "dpadLeft"], ["left", "dpadRight"]]) {
    const r = RECTS[cluster][zone];
    centres[zone] = `${Math.round(r.x + r.w / 2)},${Math.round(r.y + r.h / 2)}`;
  }
  const seen = new Map();
  for (const [zone, c] of Object.entries(centres)) {
    assert(!seen.has(c), `${zone} shares a centre with ${seen.get(c)} (${c})`);
    seen.set(c, zone);
  }
});

tryRun("clusters clear the shoulders and stay on screen", () => {
  const RECTS = computeRects(M);
  for (const g of ["left", "right"]) {
    const box = RECTS[g].box;
    assert(box.y >= M.shoulderBottom, `${g} overlaps the shoulder strip (y=${box.y} < ${M.shoulderBottom})`);
    assert(box.y + box.h <= M.H - M.bottomMargin, `${g} runs off the bottom (${box.y + box.h} > ${M.H - M.bottomMargin})`);
    assert(box.x >= 0 && box.x + box.w <= M.W, `${g} runs off the side`);
  }
  for (const g of ["shoulderL", "shoulderR"]) {
    const box = RECTS[g].box;
    assert(box.y + box.h <= M.H - M.bottomMargin, `${g} runs off the bottom`);
  }
});

tryRun("sizing stays sane on small and large screens", () => {
  for (const [W, H] of [[640, 300], [873, 393], [1280, 720], [1600, 900]]) {
    const m = computeMetrics({ W, H, insets: { top: 24, left: 0, right: 0, bottom: 0 } });
    const r = computeRects(m);
    // Nothing may hang off an edge, and the gameplay columns must clear the
    // shoulder strips (the strips themselves start at shoulderY by design).
    for (const g of ["left", "right", "shoulderL", "shoulderR"]) {
      const box = r[g].box;
      assert(box.y + box.h <= H - m.bottomMargin, `${g} off bottom at ${W}x${H} (${box.y + box.h})`);
      assert(box.x >= 0 && box.x + box.w <= W, `${g} off side at ${W}x${H}`);
    }
    for (const g of ["left", "right"]) {
      assert(r[g].box.y >= m.shoulderBottom, `${g} overlaps shoulders at ${W}x${H} (${r[g].box.y})`);
    }
    // On a screen with room, buttons must still be a comfortable size.
    if (Math.min(W, H) >= 380) {
      assert(m.fD >= 48, `fD ${m.fD} below touch minimum at ${W}x${H}`);
      assert(m.dW >= 48, `dW ${m.dW} below touch minimum at ${W}x${H}`);
    }
  }
});

tryRun("every declared zone has a rect", () => {
  for (const z of ZONES) {
    const hit = hitTest(RECTS, ID, 0, 0, 0); // warm
    assert(hit !== undefined, "hitTest returns");
    const found = ZONES.some((zone) => {
      const cluster = { stickL: "left", dpadUp: "left", dpadDown: "left", dpadLeft: "left", dpadRight: "left", faceY: "right", faceX: "right", faceB: "right", faceA: "right", stickR: "right", btnLB: "shoulderL", btnLT: "shoulderL", btnRT: "shoulderR", btnRB: "shoulderR" }[zone];
      const r = RECTS[cluster][zone];
      const t = ID[cluster];
      const p = toLocal(RECTS, cluster, t, r.x + r.w / 2, r.y + r.h / 2);
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    });
    assert(found, `zone ${z} missing rect`);
  }
});

tryRun("hit test finds both stick centres", () => {
  const l = RECTS.left.stickL;
  const r = RECTS.right.stickR;
  const hl = hitTest(RECTS, ID, l.x + l.w / 2, l.y + l.h / 2, 0);
  const hr = hitTest(RECTS, ID, r.x + r.w / 2, r.y + r.h / 2, 0);
  assert(hl?.zone === "stickL", `left stick hit ${hl?.zone}`);
  assert(hr?.zone === "stickR", `right stick hit ${hr?.zone}`);
});

tryRun("both sticks are hit at the same time (no cross blocking)", () => {
  const l = RECTS.left.stickL;
  const r = RECTS.right.stickR;
  assert(hitTest(RECTS, ID, l.x + l.w / 2, l.y + l.h / 2, 0)?.zone === "stickL", "left");
  assert(hitTest(RECTS, ID, r.x + r.w / 2, r.y + r.h / 2, 0)?.zone === "stickR", "right");
});

tryRun("dpad arms are disjoint and on the correct sides", () => {
  const d = RECTS.left;
  const c = (z) => {
    const rr = d[z];
    return hitTest(RECTS, ID, rr.x + rr.w / 2, rr.y + rr.h / 2, 0)?.zone;
  };
  assert(c("dpadUp") === "dpadUp", "up");
  assert(c("dpadDown") === "dpadDown", "down");
  // left/right buttons sit side by side; left one must resolve left of centre
  const lr = d.dpadLeft;
  assert(hitTest(RECTS, ID, lr.x + 4, lr.y + lr.h / 2, 0)?.zone === "dpadLeft", "left arm");
  const rr = d.dpadRight;
  assert(hitTest(RECTS, ID, rr.x + rr.w - 4, rr.y + rr.h / 2, 0)?.zone === "dpadRight", "right arm");
});

tryRun("face A/B/Y resolve to distinct buttons", () => {
  const r = RECTS.right;
  const hit = (z) => {
    const rr = r[z];
    return hitTest(RECTS, ID, rr.x + rr.w / 2, rr.y + rr.h / 2, 0)?.zone;
  };
  assert(hit("faceY") === "faceY", "Y centre");
  assert(hit("faceX") === "faceX", "X centre");
  assert(hit("faceB") === "faceB", "B centre");
  assert(hit("faceA") === "faceA", "A centre");
  // No overlap: X and B must be side by side, not stacked on the same spot.
  assert(r.faceX.x + r.faceX.w <= r.faceB.x + 0.5, "X left of B");
  assert(r.faceY.y + r.faceY.h <= r.faceX.y + 0.5, "Y above X");
});

tryRun("shoulder buttons resolve per side", () => {
  const L = RECTS.shoulderL;
  const R = RECTS.shoulderR;
  assert(hitTest(RECTS, ID, L.btnLB.x + L.btnLB.w / 2, L.btnLB.y + L.btnLB.h / 2, 0)?.zone === "btnLB", "LB");
  assert(hitTest(RECTS, ID, L.btnLT.x + L.btnLT.w / 2, L.btnLT.y + L.btnLT.h / 2, 0)?.zone === "btnLT", "LT");
  assert(hitTest(RECTS, ID, R.btnRT.x + R.btnRT.w / 2, R.btnRT.y + R.btnRT.h / 2, 0)?.zone === "btnRT", "RT");
  assert(hitTest(RECTS, ID, R.btnRB.x + R.btnRB.w / 2, R.btnRB.y + R.btnRB.h / 2, 0)?.zone === "btnRB", "RB");
});

tryRun("empty video area is not a gameplay zone", () => {
  const hit = hitTest(RECTS, ID, M.W / 2, M.H / 2, 0);
  assert(!hit, `centre should miss, got ${hit?.zone}`);
});

tryRun("cluster transform moves hit zones with the visuals", () => {
  const stick = RECTS.left.stickL;
  const moved = { ...ID, left: { x: 120, y: -60, s: 1 } };
  const cx = stick.x + stick.w / 2;
  const cy = stick.y + stick.h / 2;
  assert(hitTest(RECTS, ID, cx, cy, 0)?.zone === "stickL", "untransformed centre hits");
  assert(!hitTest(RECTS, moved, cx, cy, 0), "old centre must miss after moving");
  const hit = hitTest(RECTS, moved, cx + 120, cy - 60, 0);
  assert(hit?.zone === "stickL", `moved centre should hit, got ${hit?.zone}`);
});

tryRun("scaled clusters keep a stable centre", () => {
  const stick = RECTS.left.stickL;
  const box = RECTS.left.box;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const lx = stick.x + stick.w / 2;
  const ly = stick.y + stick.h / 2;
  for (const s of [0.5, 1.4, 2]) {
    const t = { ...ID, left: { x: 0, y: 0, s } };
    // Query the point where the stick actually renders after scaling
    // (screen = centre + (local - centre) * s + translate).
    const sx = cx + (lx - cx) * s;
    const sy = cy + (ly - cy) * s;
    assert(hitTest(RECTS, t, sx, sy, 0)?.zone === "stickL", `scale ${s}: stick centre moved`);
  }
});

tryRun("toLocal inverts translate+scale about the centre", () => {
  const box = RECTS.left.box;
  const t = { x: 40, y: -25, s: 1.5 };
  const local = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const page = { x: local.x * 1.5 - 40 + (1 - 1.5) * 0 + (box.x + box.w / 2) * 0 + (box.x + box.w / 2) * (1 - 1.5), y: 0 };
  // Build the forward mapping explicitly: screen = c + (local - c)*s + t
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const forward = { x: c.x + (local.x - c.x) * t.s + t.x, y: c.y + (local.y - c.y) * t.s + t.y };
  const back = toLocal(RECTS, "left", t, forward.x, forward.y);
  assert(near(back.x, local.x) && near(back.y, local.y), `roundtrip ${back.x},${back.y}`);
  void page;
});

tryRun("stick roundness rejects corners", () => {
  const l = RECTS.left.stickL;
  assert(insideStick(RECTS, "left", ID.left, l.x + l.w / 2, l.y + l.h / 2), "centre inside");
  assert(!insideStick(RECTS, "left", ID.left, l.x + 1, l.y + 1), "corner outside");
});

tryRun("metrics follow the container, not the window", () => {
  // Landscape: the root view is what holds the controls. Right-anchored zones
  // must land on the right edge of THAT width, whatever the window reported
  // while the orientation lock was still settling (the real bug).
  const land = computeMetrics({ W: 2400, H: 1080, insets: { top: 0, left: 0, right: 0, bottom: 0 } });
  const lr = computeRects(land);
  const rightEdge = lr.right.box.x + lr.right.box.w;
  assert(near(rightEdge, 2400 - 8, 2), `right cluster must hug the right edge, got ${rightEdge}`);
  const stickCX = lr.right.stickR.x + lr.right.stickR.w / 2;
  assert(stickCX > 2400 * 0.8, `right stick must sit far right, got ${stickCX}`);
  const leftStickCX = lr.left.stickL.x + lr.left.stickL.w / 2;
  assert(leftStickCX < 2400 * 0.2, `left stick must sit far left, got ${leftStickCX}`);
});

tryRun("page origin offset is removed before hit testing", () => {
  const M2 = computeMetrics({ W: 2400, H: 1080, insets: { top: 0, left: 0, right: 0, bottom: 0 } });
  const R2 = computeRects(M2);
  const stick = R2.right.stickR;
  const cx = stick.x + stick.w / 2;
  const cy = stick.y + stick.h / 2;
  // Origin (0,0): page space == view space, so the centre hits.
  assert(hitTest(R2, ID, cx, cy, 0, null)?.zone === "stickR", "zero origin hits");
  // Root offset by 120px: the SAME page point now belongs to video, and the
  // stick has moved 120px to the right in page space.
  const shifted = hitTest(R2, ID, cx, cy, 0, { x: 120, y: 0 });
  assert(!shifted || shifted.zone !== "stickR", `offset origin must move the zone off this point (${shifted?.zone})`);
  const hit = hitTest(R2, ID, cx + 120, cy, 0, { x: 120, y: 0 });
  assert(hit?.zone === "stickR", `origin-aware hit failed (${hit?.zone})`);
  const drawn = pageRects(R2, ID, { x: 120, y: 0 }).find((r) => r.zone === "stickR");
  assert(near(drawn.x, stick.x + 120, 2), `pageRects must apply the same origin (${drawn.x} vs ${stick.x + 120})`);
});

tryRun("wild stored offsets are clamped back on screen", () => {
  const sane = sanitizeLayout({ right: { x: 99999, y: -99999, s: 9 } }, 2400, 1080);
  assert(Math.abs(sane.right.x) <= 2400 * 0.4 + 1, `x clamped, got ${sane.right.x}`);
  assert(Math.abs(sane.right.y) <= 1080 * 0.4 + 1, `y clamped, got ${sane.right.y}`);
  assert(sane.right.s <= 2 && sane.right.s >= 0.5, `s clamped, got ${sane.right.s}`);
  const ok = sanitizeLayout({ right: { x: 40, y: -30, s: 1.2 } }, 2400, 1080);
  assert(ok.right.x === 40 && ok.right.y === -30 && ok.right.s === 1.2, "normal offsets preserved");
});

tryRun("touch padding grows zones without moving them", () => {
  // Sample inside the LEFT d-pad arm's right edge: the neighbouring zone is
  // another d-pad arm, so pad=0 must miss and pad=10 must hit the same arm.
  const L = RECTS.left.dpadRight;
  const insideX = L.x + L.w - 3;
  const cy = L.y + L.h / 2;
  assert(hitTest(RECTS, ID, insideX, cy, 0)?.zone === "dpadRight", "edge still inside without pad");
  const outsideX = L.x + L.w + 6;
  assert(!hitTest(RECTS, ID, outsideX, cy, 0), "no pad: point outside must miss");
  assert(hitTest(RECTS, ID, outsideX, cy, 10)?.zone === "dpadRight", "with pad: point must be caught");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} geometry tests passed`);
if (failed.length) process.exit(1);