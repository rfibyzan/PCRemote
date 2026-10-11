/**
 * Multi-touch router for the GAME overlay (pure, unit-tested, no RN).
 *
 * Every finger is tracked by its pointer identifier from its very first
 * contact, independently of the others: two sticks, a stick plus ABXY,
 * triggers plus bumpers... any combination works at once. A finger keeps
 * the control it landed on until it lifts (sliding off a stick keeps
 * steering it; sliding across the D-pad or ABXY rolls through buttons).
 *
 * `pad` is a GamepadState-like object (setButton/setStick/setTrigger).
 * Coordinates are overlay-local pixels.
 */
import { CONTROL_DEFS, controlBox, dpadDirs, faceButton, hitTest, stickVector } from "./layout.js";

const DOUBLE_TAP_MS = 300;

export class TouchRouter {
  constructor({ pad, getLayout, getSize, onVisual, onHaptic, now }) {
    this.pad = pad;
    this.getLayout = getLayout;
    this.getSize = getSize;
    this.onVisual = onVisual || (() => {});
    this.onHaptic = onHaptic || (() => {});
    this.now = now || (() => Date.now());
    this.fingers = new Map(); // pointerId -> { ctrl, buttons:Set, ox, oy }
    this.stickOwner = new Map(); // ctrl -> pointerId
    this.lastStickEnd = {}; // ctrl -> ms
    this.visual = { pressed: {}, knobs: {}, origins: {}, triggers: {} };
  }

  _emit() {
    this.onVisual(this.visual);
  }

  _held(name) {
    for (const f of this.fingers.values()) if (f.buttons.has(name)) return true;
    return false;
  }

  /** Replace the set of buttons a finger holds; pad state = OR over fingers. */
  _setFingerButtons(f, next) {
    const changed = new Set([...f.buttons, ...next]);
    let pressedNew = false;
    for (const n of f.buttons) if (!next.has(n)) f.buttons.delete(n);
    for (const n of next) {
      if (!f.buttons.has(n)) {
        f.buttons.add(n);
        pressedNew = true;
      }
    }
    for (const n of changed) {
      const down = this._held(n);
      this.pad.setButton(n, down);
      this.visual.pressed = { ...this.visual.pressed, [n]: down };
    }
    if (pressedNew) this.onHaptic();
  }

  start(id, px, py) {
    if (this.fingers.has(id)) this.end(id); // reused pointer id: drop stale state
    const layout = this.getLayout();
    const { W, H } = this.getSize();
    const floating = layout.stickMode === "floating";
    const ctrl = hitTest(layout, W, H, px, py, { floatingZones: floating });
    if (!ctrl) return null;
    const def = CONTROL_DEFS[ctrl];
    if (def.kind === "stick" && this.stickOwner.has(ctrl)) return null; // one thumb per stick
    const box = controlBox(layout, ctrl, W, H);
    const f = { ctrl, buttons: new Set(), ox: box.cx, oy: box.cy };
    this.fingers.set(id, f);
    if (def.kind === "stick") {
      this.stickOwner.set(ctrl, id);
      if (floating) {
        f.ox = px;
        f.oy = py;
      }
      this.visual.origins = { ...this.visual.origins, [ctrl]: { x: f.ox - box.cx, y: f.oy - box.cy } };
      const t = this.now();
      if (t - (this.lastStickEnd[ctrl] || 0) < DOUBLE_TAP_MS) this._setFingerButtons(f, new Set([def.click]));
    }
    this.move(id, px, py);
    if (def.kind === "trigger") this.onHaptic();
    return ctrl;
  }

  move(id, px, py) {
    const f = this.fingers.get(id);
    if (!f) return;
    const layout = this.getLayout();
    const { W, H } = this.getSize();
    const def = CONTROL_DEFS[f.ctrl];
    const box = controlBox(layout, f.ctrl, W, H);
    switch (def.kind) {
      case "stick": {
        const travel = (box.w / 2) * 0.72;
        const v = stickVector(f.ox, f.oy, travel, px, py);
        this.pad.setStick(def.side, v.x, v.y, layout.deadzone);
        this.visual.knobs = { ...this.visual.knobs, [f.ctrl]: { x: v.x * travel, y: -v.y * travel } };
        break;
      }
      case "dpad": {
        const d = dpadDirs(box.cx, box.cy, box.w, px, py);
        this._setFingerButtons(f, new Set(Object.keys(d).filter((k) => d[k])));
        break;
      }
      case "face":
        this._setFingerButtons(f, new Set([faceButton(box.cx, box.cy, px, py)]));
        break;
      case "trigger":
        if (!this.visual.triggers[f.ctrl]) {
          this.pad.setTrigger(def.trigger, 1);
          this.visual.triggers = { ...this.visual.triggers, [f.ctrl]: 1 };
        }
        break;
      default:
        if (!f.buttons.has(def.button)) this._setFingerButtons(f, new Set([def.button]));
    }
    this._emit();
  }

  end(id) {
    const f = this.fingers.get(id);
    if (!f) return;
    const def = CONTROL_DEFS[f.ctrl];
    this._setFingerButtons(f, new Set());
    this.fingers.delete(id);
    if (def.kind === "stick") {
      this.stickOwner.delete(f.ctrl);
      this.lastStickEnd[f.ctrl] = this.now();
      this.pad.setStick(def.side, 0, 0);
      const { [f.ctrl]: _k, ...knobs } = this.visual.knobs;
      const { [f.ctrl]: _o, ...origins } = this.visual.origins;
      this.visual.knobs = knobs;
      this.visual.origins = origins;
    } else if (def.kind === "trigger") {
      let still = false;
      for (const g of this.fingers.values()) if (g.ctrl === f.ctrl) still = true;
      if (!still) {
        this.pad.setTrigger(def.trigger, 0);
        const { [f.ctrl]: _t, ...triggers } = this.visual.triggers;
        this.visual.triggers = triggers;
      }
    }
    this._emit();
  }

  /** Release fingers the platform no longer reports (lost touchEnd). */
  sync(activeIds) {
    const alive = new Set(activeIds);
    for (const id of [...this.fingers.keys()]) if (!alive.has(id)) this.end(id);
  }

  releaseAll() {
    for (const id of [...this.fingers.keys()]) this.end(id);
  }

  /** Controls currently held by at least one finger. */
  activeControls() {
    return [...new Set([...this.fingers.values()].map((f) => f.ctrl))];
  }
}
