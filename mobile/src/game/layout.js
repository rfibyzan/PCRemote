/**
 * GAME overlay layout model (pure, framework-free, unit-tested).
 *
 * A layout is data: every control has a normalized centre (x, y in 0..1 of
 * the overlay box), a base size in dp, its own optional opacity and a
 * visibility flag. Global settings (opacity, scale, haptics, stick mode,
 * deadzone) sit beside the controls. The renderer, the touch router and the
 * editor all read the SAME numbers through controlBox(), so what you see is
 * exactly what you can touch.
 */

export const LAYOUT_VERSION = 2;

/**
 * Control catalogue. `kind` decides rendering + touch behaviour:
 *  stick   analog stick (+ double-tap-and-hold = L3/R3 click)
 *  dpad    8-way cross, slide between directions
 *  face    A/B/X/Y diamond, slide between buttons
 *  bumper  LB/RB digital
 *  trigger LT/RT (tap = full, per protocol contract)
 *  small   round system / stick-click buttons
 */
export const CONTROL_DEFS = {
  stickL: { kind: "stick", side: "left", click: "l3", label: "Stik kiri", size: 150 },
  stickR: { kind: "stick", side: "right", click: "r3", label: "Stik kanan", size: 140 },
  dpad: { kind: "dpad", label: "D-pad", size: 138 },
  face: { kind: "face", label: "A B X Y", size: 156 },
  lb: { kind: "bumper", button: "lb", label: "LB", size: 96 },
  rb: { kind: "bumper", button: "rb", label: "RB", size: 96 },
  lt: { kind: "trigger", trigger: "left", label: "LT", size: 80 },
  rt: { kind: "trigger", trigger: "right", label: "RT", size: 80 },
  back: { kind: "small", button: "back", label: "View", icon: "back", size: 46 },
  guide: { kind: "small", button: "guide", label: "Guide", icon: "guide", size: 54 },
  start: { kind: "small", button: "start", label: "Menu", icon: "start", size: 46 },
  l3: { kind: "small", button: "l3", label: "L3", icon: "text", size: 52 },
  r3: { kind: "small", button: "r3", label: "R3", icon: "text", size: 52 },
};

export const CONTROL_IDS = Object.keys(CONTROL_DEFS);

/** Default Xbox-style landscape layout (Moonlight-like placement). */
export const DEFAULT_CONTROLS = {
  lt: { x: 0.07, y: 0.13 },
  lb: { x: 0.2, y: 0.13 },
  rb: { x: 0.8, y: 0.13 },
  rt: { x: 0.93, y: 0.13 },
  stickL: { x: 0.12, y: 0.47 },
  dpad: { x: 0.31, y: 0.79 },
  face: { x: 0.875, y: 0.47 },
  stickR: { x: 0.69, y: 0.79 },
  back: { x: 0.41, y: 0.13 },
  guide: { x: 0.5, y: 0.13 },
  start: { x: 0.59, y: 0.13 },
  l3: { x: 0.08, y: 0.86, visible: false },
  r3: { x: 0.92, y: 0.86, visible: false },
};

export const DEFAULT_SETTINGS = {
  opacity: 0.6, // global control opacity
  scale: 1, // global size multiplier
  haptics: true,
  stickMode: "fixed", // "fixed" | "floating"
  deadzone: 0.12,
  showStream: true,
};

export const LIMITS = {
  opacity: [0.1, 1],
  scale: [0.6, 1.6],
  size: [0.5, 2], // per-control multiplier
  deadzone: [0, 0.4],
};

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function defaultLayout() {
  const controls = {};
  for (const id of CONTROL_IDS) {
    const d = DEFAULT_CONTROLS[id];
    controls[id] = { x: d.x, y: d.y, size: 1, opacity: null, visible: d.visible !== false };
  }
  return { version: LAYOUT_VERSION, ...DEFAULT_SETTINGS, controls };
}

/** Shape + clamp anything loaded from disk; unknown keys are dropped. */
export function cleanLayout(raw) {
  const base = defaultLayout();
  if (!raw || typeof raw !== "object" || raw.version !== LAYOUT_VERSION) return base;
  const out = {
    version: LAYOUT_VERSION,
    opacity: clamp(raw.opacity ?? base.opacity, ...LIMITS.opacity),
    scale: clamp(raw.scale ?? base.scale, ...LIMITS.scale),
    haptics: raw.haptics === undefined ? base.haptics : Boolean(raw.haptics),
    stickMode: raw.stickMode === "floating" ? "floating" : "fixed",
    deadzone: clamp(raw.deadzone ?? base.deadzone, ...LIMITS.deadzone),
    showStream: raw.showStream === undefined ? base.showStream : Boolean(raw.showStream),
    controls: {},
  };
  for (const id of CONTROL_IDS) {
    const b = base.controls[id];
    const c = raw.controls?.[id] || {};
    out.controls[id] = {
      x: clamp(c.x ?? b.x, 0, 1),
      y: clamp(c.y ?? b.y, 0, 1),
      size: clamp(c.size ?? b.size, ...LIMITS.size),
      opacity: c.opacity === null || c.opacity === undefined ? null : clamp(c.opacity, ...LIMITS.opacity),
      visible: c.visible === undefined ? b.visible : Boolean(c.visible),
    };
  }
  return out;
}

/** Effective opacity for a control (own value, else global). */
export function controlOpacity(layout, id) {
  const own = layout.controls[id]?.opacity;
  return own === null || own === undefined ? layout.opacity : own;
}

/**
 * Screen fit: base sizes are tuned for a ~400dp-tall landscape view and
 * scale with the real height, so a 360dp phone and a 600dp tablet get the
 * same proportions.
 */
export function screenFit(H) {
  return clamp((Number(H) || 400) / 400, 0.75, 1.5);
}

/** Pixel width/height of a control (before positioning). */
export function controlDims(layout, id, H) {
  const def = CONTROL_DEFS[id];
  const c = layout.controls[id];
  const s = def.size * (c?.size || 1) * (layout.scale || 1) * screenFit(H);
  if (def.kind === "bumper") return { w: s, h: Math.round(s * 0.44) };
  if (def.kind === "trigger") return { w: s, h: Math.round(s * 0.62) };
  return { w: s, h: s };
}

/**
 * Pixel box of a control inside a W x H overlay: centre, size, top-left.
 * The centre is clamped so the whole control stays on screen.
 */
export function controlBox(layout, id, W, H) {
  const { w, h } = controlDims(layout, id, H);
  const c = layout.controls[id];
  const cx = clamp(c.x * W, w / 2, Math.max(w / 2, W - w / 2));
  const cy = clamp(c.y * H, h / 2, Math.max(h / 2, H - h / 2));
  return { id, cx, cy, w, h, left: cx - w / 2, top: cy - h / 2 };
}

/** Touch padding around a control's visual (bigger target, never smaller). */
export const TOUCH_PAD = 10;

function isRound(kind) {
  return kind === "stick" || kind === "small" || kind === "face" || kind === "dpad";
}

/**
 * Hit-test a point (overlay-local px). Returns the control id or null.
 * Among overlapping hits the one whose centre is relatively closest wins,
 * so neighbouring controls split the overlap fairly.
 */
export function hitTest(layout, W, H, px, py, { floatingZones = false } = {}) {
  let best = null;
  let bestScore = Infinity;
  for (const id of CONTROL_IDS) {
    const c = layout.controls[id];
    if (!c?.visible) continue;
    const def = CONTROL_DEFS[id];
    const b = controlBox(layout, id, W, H);
    let score;
    if (isRound(def.kind)) {
      // Floating sticks accept touches in a wider zone around their home spot.
      const grow = floatingZones && def.kind === "stick" ? 1.7 : 1;
      const r = (Math.max(b.w, b.h) / 2) * grow + TOUCH_PAD;
      const d = Math.hypot(px - b.cx, py - b.cy);
      if (d > r) continue;
      score = d / r;
    } else {
      const hw = b.w / 2 + TOUCH_PAD;
      const hh = b.h / 2 + TOUCH_PAD;
      const dx = Math.abs(px - b.cx);
      const dy = Math.abs(py - b.cy);
      if (dx > hw || dy > hh) continue;
      score = Math.max(dx / hw, dy / hh);
    }
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Stick vector from a touch: -1..1 each axis, +y UP (XInput), unit-clamped. */
export function stickVector(cx, cy, radius, px, py) {
  const r = Math.max(1, radius);
  let x = (px - cx) / r;
  let y = -(py - cy) / r;
  const m = Math.hypot(x, y);
  if (m > 1) {
    x /= m;
    y /= m;
  }
  return { x, y };
}

/**
 * D-pad directions for a touch: 8-way with a small dead centre, so sliding a
 * thumb around the cross rolls through diagonals like a real pad.
 */
export function dpadDirs(cx, cy, size, px, py) {
  const dx = px - cx;
  const dy = py - cy;
  const out = { up: false, down: false, left: false, right: false };
  if (Math.hypot(dx, dy) < size * 0.12) return out;
  const a = (Math.atan2(-dy, dx) * 180) / Math.PI; // 0 = right, 90 = up
  const deg = (a + 360) % 360;
  out.right = deg < 67.5 || deg > 292.5;
  out.up = deg > 22.5 && deg < 157.5;
  out.left = deg > 112.5 && deg < 247.5;
  out.down = deg > 202.5 && deg < 337.5;
  return out;
}

/** Face button under a touch: diamond quadrants (Y top, A bottom, X left, B right). */
export function faceButton(cx, cy, px, py) {
  const dx = px - cx;
  const dy = py - cy;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "x" : "b";
  return dy < 0 ? "y" : "a";
}

/** Move a control to an overlay-local pixel centre (editor drag). */
export function moveControl(layout, id, px, py, W, H, grid = 0) {
  const { w, h } = controlDims(layout, id, H);
  let cx = clamp(px, w / 2, Math.max(w / 2, W - w / 2));
  let cy = clamp(py, h / 2, Math.max(h / 2, H - h / 2));
  if (grid > 0) {
    cx = Math.round(cx / grid) * grid;
    cy = Math.round(cy / grid) * grid;
  }
  return patchControl(layout, id, { x: cx / Math.max(1, W), y: cy / Math.max(1, H) });
}

export function patchControl(layout, id, patch) {
  return { ...layout, controls: { ...layout.controls, [id]: { ...layout.controls[id], ...patch } } };
}

export function patchSettings(layout, patch) {
  return cleanLayout({ ...layout, ...patch });
}

/** Step a numeric field and keep it inside LIMITS (rounded to 2 decimals). */
export function stepValue(v, delta, [lo, hi]) {
  return Math.round(clamp((Number(v) || 0) + delta, lo, hi) * 100) / 100;
}
