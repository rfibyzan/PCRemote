/**
 * GAME virtual-Xbox state: buttons, sticks, triggers.
 * Sticks are normalized -1..1 floats (client applies deadzone + smoothing);
 * +ly/+ry means UP to match XInput (screen-space Y is flipped by callers).
 * Triggers are 0..1 floats. snapshot() matches the agent gamepad protocol.
 */
import { GAMEPAD_BUTTONS } from "../protocol";

export const STICK_DEADZONE = 0.12;

export function applyDeadzone(x, y, dead = STICK_DEADZONE) {
  const mag = Math.hypot(x, y);
  if (mag < dead) return { x: 0, y: 0 };
  const scale = Math.min(1, (mag - dead) / (1 - dead)) / (mag || 1);
  return { x: x * scale, y: y * scale };
}

export class GamepadState {
  constructor() {
    this.reset();
  }

  reset() {
    this.btn = {};
    this.lx = 0; this.ly = 0; this.rx = 0; this.ry = 0;
    this.lt = 0; this.rt = 0;
    this._dirty = true;
  }

  setButton(name, down) {
    if (!GAMEPAD_BUTTONS[name]) return;
    const next = Boolean(down);
    if (Boolean(this.btn[name]) !== next) {
      this.btn[name] = next;
      this._dirty = true;
    }
  }

  setStick(which, x, y, dead = STICK_DEADZONE) {
    const d = applyDeadzone(x, y, dead);
    if (which === "left") {
      if (this.lx !== d.x || this.ly !== d.y) { this.lx = d.x; this.ly = d.y; this._dirty = true; }
    } else {
      if (this.rx !== d.x || this.ry !== d.y) { this.rx = d.x; this.ry = d.y; this._dirty = true; }
    }
  }

  setTrigger(which, value) {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    if (which === "left") {
      if (this.lt !== v) { this.lt = v; this._dirty = true; }
    } else if (this.rt !== v) { this.rt = v; this._dirty = true; }
  }

  /** Full controller state for { t: "gamepad", state }. */
  snapshot() {
    let buttons = 0;
    const btn = {};
    for (const [name, bit] of Object.entries(GAMEPAD_BUTTONS)) {
      const down = Boolean(this.btn[name]);
      btn[name] = down;
      if (down) buttons |= bit;
    }
    return {
      buttons,
      btn,
      lt: this.lt,
      rt: this.rt,
      lx: this.lx,
      ly: this.ly,
      rx: this.rx,
      ry: this.ry,
    };
  }

  takeDirty() {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }
}
