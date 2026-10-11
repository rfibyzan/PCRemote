/**
 * Pure layout geometry for the GAME overlay.
 *
 * Why analytic instead of measure(): the root touch router must hit-test a
 * finger's page coordinates against every gameplay control BEFORE claiming
 * the gesture, and on some Android builds measure() inside the same frame
 * returns stale/null rects (which silently dropped every touch). All numbers
 * below come from the very same constants the components render with, so the
 * hit zones cannot drift from the visuals.
 *
 * Everything here is pure and framework-free so it can be unit tested.
 */

// Shoulder strip buttons are text-sized (LB/LT/RT/RB), so their exact pixel
// width is font-dependent. We hit-test a slightly generous fixed band instead
// — a bigger touch target, never a smaller one.
export const ZONES = [
  "stickL",
  "dpadUp",
  "dpadDown",
  "dpadLeft",
  "dpadRight",
  "faceY",
  "faceX",
  "faceB",
  "faceA",
  "stickR",
  "btnLB",
  "btnLT",
  "btnRT",
  "btnRB",
];

// Gaps between controls. Exported so the JSX renders the exact spacing the
// hit-test assumes — one source of truth, no drift.
export const CLUSTER_GAP = 10;
export const FACE_GAP = 6;
export const PAIR_GAP = 6;
export const SHOULDER_BTN_W = 52;
export const SHOULDER_BTN_H = 38;
export const SHOULDER_GAP = 6;

// Android's minimum comfortable touch target. Nothing below this: a 38x33dp
// d-pad arm was the reason ABXY and the d-pad looked like specks next to the
// text-sized shoulder buttons.
const MIN_TOUCH = 48;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Control sizing.
 *
 * Face buttons and d-pad arms are sized from the screen, NOT from the stick
 * radius. Deriving them from the stick meant `k = R/62` clamped the whole pad
 * to ~0.74 on a 393dp-wide phone, producing 40dp face buttons and 38x33dp
 * d-pad arms — under the 48dp minimum, so they read as specks.
 *
 * `fitLimit` then shrinks anything that would push the cluster off-screen, but
 * never below MIN_TOUCH: a cramped pad beats an unusable one.
 */
export function computeMetrics({ W, H, insets }) {
  const shortEdge = Math.min(W, H);

  const leftPad = 8 + insets.left;
  const rightPad = 8 + insets.right;
  const topPad = insets.top + 20;
  const shoulderY = topPad + 52;
  const shoulderBottom = shoulderY + SHOULDER_BTN_H;
  const clusterTop = shoulderBottom + 8;
  const BOTTOM_MARGIN = 8;

  const budget = H - BOTTOM_MARGIN - clusterTop;
  const gaps = Math.max(FACE_GAP, PAIR_GAP) * 2;
  // A column is stick + cluster gap + three rows + two row gaps, and the stick
  // and the buttons compete for the SAME height. Reserve the stick's minimum
  // diameter FIRST (48dp), then give the rest to the buttons: solving the
  // buttons without that reservation made the stick collapse to 24 and the
  // column run off the bottom of the screen.
  const R_MIN = 24;
  const sRoom = (budget - CLUSTER_GAP - R_MIN * 2 - gaps) / 3;
  const sFloor = Math.min(MIN_TOUCH, Math.floor(sRoom));
  const sMax = Math.min(96, Math.floor(sRoom));
  const btn = clamp(Math.min(Math.round(shortEdge * 0.145), sMax), sFloor, sMax);
  // One button size for face AND d-pad: two sizes meant the taller d-pad column
  // could exceed the vertical budget the sizing pass reserved for it and run
  // off the bottom of the screen.
  const fD = btn;
  const dW = btn;
  const dH = btn; // square arms: easier to hit and symmetric

  // Stick takes the height that is left, never below its 48dp minimum.
  const wantStick = clamp(Math.round(shortEdge * 0.095), 40, 110);
  const stickRoom = budget - CLUSTER_GAP - btn * 3 - Math.max(FACE_GAP, PAIR_GAP) * 2;
  const R = clamp(Math.min(wantStick, Math.floor(stickRoom / 2)), R_MIN, 110);
  const K = Math.round(R * 0.42);

  return {
    W,
    H,
    insets,
    R,
    K,
    fD,
    dW,
    dH,
    leftPad,
    rightPad,
    topPad,
    shoulderY,
    shoulderBottom,
    clusterTop,
    bottomMargin: BOTTOM_MARGIN,
  };
}

/**
 * Layout offsets far outside the screen are unreachable dead zones (a cluster
 * dragged thousands of dp away, or junk from an older layout format). Clamp
 * instead of trusting them, so every control stays hittable.
 */
export function sanitizeLayout(raw, W, H) {
  const limitX = Math.max(60, W * 0.4);
  const limitY = Math.max(60, H * 0.4);
  const out = {};
  for (const id of Object.keys(raw || {})) {
    const p = raw[id] || {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    out[id] = {
      x: Math.max(-limitX, Math.min(limitX, num(p.x, 0))),
      y: Math.max(-limitY, Math.min(limitY, num(p.y, 0))),
      s: Math.max(0.5, Math.min(2, num(p.s, 1))),
    };
  }
  return out;
}

function rect(x, y, w, h) {
  return { x, y, w, h };
}

/**
 * Untransformed (local) rects for every gameplay zone, grouped by the cluster
 * that positions them. Mirrors the JSX: a shrink-wrapped column with
 * alignItems:center and gap, anchored top/left or top/right.
 */
export function computeRects(m) {
  const { R, dW, dH, fD, leftPad, rightPad, clusterTop, shoulderY, W } = m;
  const dpadW = dW * 2 + PAIR_GAP;
  // Three rows (up / left+right / down), so the cross is as tall as it is wide
  // plus the middle gap. Deriving the height from the width alone is what let
  // the up/down arms overlap the left/right arms.
  const dpadH = dH * 3 + PAIR_GAP * 2;
  // The face is a diamond: Y on top, X|B side by side in the middle, A at the
  // bottom. The middle row is wider than the cluster and centers on it, so X
  // sits in its left half and B in its right half — PAIR_GAP keeps them apart
  // instead of letting them read as one "XB" blob.
  const faceW = fD * 2 + PAIR_GAP;
  const faceH = fD * 3 + FACE_GAP * 2;

  // ---- left cluster: stick on top, dpad below (column, centered) ----
  const leftW = Math.max(R * 2, dpadW);
  const leftH = R * 2 + CLUSTER_GAP + dpadH;
  const leftX = leftPad;
  const leftY = clusterTop;
  const centerIn = (colX, colW, childW) => colX + (colW - childW) / 2;

  const dpadX = centerIn(leftX, leftW, dpadW);
  const dpadY = leftY + R * 2 + CLUSTER_GAP;
  const midX = dpadX + dpadW / 2;
  // Middle row sits between two PAIR_GAP gaps: up ends at dH, left/right start
  // one gap lower, down starts another gap below that.
  const midRowY = dpadY + dH + PAIR_GAP;

  // ---- right cluster: face buttons on top, stick below ----
  const rightW = Math.max(faceW, R * 2);
  const rightH = faceH + CLUSTER_GAP + R * 2;
  const rightX = W - rightPad - rightW;
  const rightY = clusterTop;
  const faceX = centerIn(rightX, rightW, faceW);
  const faceTop = rightY;
  const midY = faceTop + fD + FACE_GAP;

  return {
    left: {
      box: rect(leftX, leftY, leftW, leftH),
      stickL: rect(centerIn(leftX, leftW, R * 2), leftY, R * 2, R * 2),
      dpadUp: rect(midX - dW / 2, dpadY, dW, dH),
      dpadDown: rect(midX - dW / 2, midRowY + dH + PAIR_GAP, dW, dH),
      dpadLeft: rect(dpadX, midRowY, dW, dH),
      dpadRight: rect(dpadX + dpadW - dW, midRowY, dW, dH),
    },
    right: {
      box: rect(rightX, rightY, rightW, rightH),
      faceY: rect(faceX + PAIR_GAP / 2, faceTop, fD, fD),
      faceX: rect(faceX, midY, fD, fD),
      faceB: rect(faceX + fD + PAIR_GAP, midY, fD, fD),
      faceA: rect(faceX + PAIR_GAP / 2, midY + fD + FACE_GAP, fD, fD),
      stickR: rect(centerIn(rightX, rightW, R * 2), rightY + faceH + CLUSTER_GAP, R * 2, R * 2),
    },
    shoulderL: {
      box: rect(leftPad, shoulderY, SHOULDER_BTN_W * 2 + SHOULDER_GAP, SHOULDER_BTN_H),
      btnLB: rect(leftPad, shoulderY, SHOULDER_BTN_W, SHOULDER_BTN_H),
      btnLT: rect(leftPad + SHOULDER_BTN_W + SHOULDER_GAP, shoulderY, SHOULDER_BTN_W, SHOULDER_BTN_H),
    },
    shoulderR: {
      box: rect(W - rightPad - (SHOULDER_BTN_W * 2 + SHOULDER_GAP), shoulderY, SHOULDER_BTN_W * 2 + SHOULDER_GAP, SHOULDER_BTN_H),
      btnRT: rect(W - rightPad - (SHOULDER_BTN_W * 2 + SHOULDER_GAP), shoulderY, SHOULDER_BTN_W, SHOULDER_BTN_H),
      btnRB: rect(W - rightPad - SHOULDER_BTN_W, shoulderY, SHOULDER_BTN_W, SHOULDER_BTN_H),
    },
  };
}

/**
 * X and B sit side by side in the diamond's middle row (gap PAIR_GAP), so
 * hit order never has to disambiguate an overlapping band.
 */
export function orderedZones() {
  return [
    "stickL",
    "dpadUp",
    "dpadDown",
    "dpadLeft",
    "dpadRight",
    "faceY",
    "faceX",
    "faceB",
    "faceA",
    "stickR",
    "btnLB",
    "btnLT",
    "btnRT",
    "btnRB",
  ];
}

// Gameplay zone -> pad button name (sticks and triggers handled separately).
export const ZONE_BUTTON = {
  dpadUp: "up",
  dpadDown: "down",
  dpadLeft: "left",
  dpadRight: "right",
  faceY: "y",
  faceX: "x",
  faceB: "b",
  faceA: "a",
  btnLB: "lb",
  btnRB: "rb",
};

const CLUSTER_OF = {
  stickL: "left",
  dpadUp: "left",
  dpadDown: "left",
  dpadLeft: "left",
  dpadRight: "left",
  faceY: "right",
  faceX: "right",
  faceB: "right",
  faceA: "right",
  stickR: "right",
  btnLB: "shoulderL",
  btnLT: "shoulderL",
  btnRT: "shoulderR",
  btnRB: "shoulderR",
};

/** Map a screen(page) point into a cluster's LOCAL, untransformed space. */
export function toLocal(rects, clusterId, t, pageX, pageY) {
  const box = rects[clusterId].box;
  const scale = t.s || 1;
  // RN applies translate then scale about the view's centre (transformOrigin
  // default 50% 50%). Inverse that mapping.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return {
    x: cx + (pageX - (t.x || 0) - cx) / scale,
    y: cy + (pageY - (t.y || 0) - cy) / scale,
  };
}

function inside(r, x, y, pad) {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

/**
 * Which gameplay zone (if any) is under this page point.
 * Returns { zone, cluster } or null. `pad` grows every rect (finger-friendly
 * without changing the visuals).
 */
/**
 * Which gameplay zone (if any) is under this PAGE point.
 * `origin` is the root view's own page position: page coords are window
 * coords, the rects are view-local, so the offset must be removed first.
 */
export function hitTest(rects, layout, pageX, pageY, pad = 0, origin = null) {
  const ox = origin?.x || 0;
  const oy = origin?.y || 0;
  for (const zone of orderedZones()) {
    const clusterId = CLUSTER_OF[zone];
    const t = layout[clusterId] || { x: 0, y: 0, s: 1 };
    const p = toLocal(rects, clusterId, t, pageX - ox, pageY - oy);
    if (inside(rects[clusterId][zone], p.x, p.y, pad)) return { zone, cluster: clusterId };
  }
  return null;
}

/** Every zone as a PAGE-space rect — used to draw the debug hit-boxes. */
export function pageRects(rects, layout, origin = null) {
  const ox = origin?.x || 0;
  const oy = origin?.y || 0;
  const out = [];
  for (const zone of orderedZones()) {
    const clusterId = CLUSTER_OF[zone];
    const t = layout[clusterId] || { x: 0, y: 0, s: 1 };
    const box = rects[clusterId].box;
    const s = t.s || 1;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const r = rects[clusterId][zone];
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    // forward: screen = c + (local - c) * s + t
    out.push({
      zone,
      x: ox + cx + (c.x - cx) * s + (t.x || 0) - r.w / 2,
      y: oy + cy + (c.y - cy) * s + (t.y || 0) - r.h / 2,
      w: r.w * s,
      h: r.h * s,
    });
  }
  return out;
}

/** Sticks are round: reject corners so a finger beside the stick misses. */
export function insideStick(rects, clusterId, t, pageX, pageY) {
  const r = rects[clusterId].stickL;
  const p = toLocal(rects, clusterId, t, pageX, pageY);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rr = r.w / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return dx * dx + dy * dy <= rr * rr;
}

export const CLUSTER_OF_ZONE = CLUSTER_OF;