/**
 * GAME tests (agent side). Isolated from unit_test.js and selftest.js —
 * run with:  node src/game_test.js
 * Covers: gamepad state normalization, watchdog/disconnect reset, and a
 * static guard that index.js GAME routing exists without touching the
 * PAD / Q / TYPE / WEBCAM / WIN handlers.
 * (PC audio streaming was removed; see git history for the old suite.)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GAMEPAD_BUTTONS,
  backendStatus,
  createGamepadSession,
  normalizeGamepadState,
  resetBackendCache,
  sameGamepadState,
  zeroGamepadState,
} from "./gamepad.js";

const results = [];
function pass(name, extra = "") {
  results.push({ name, ok: true });
  console.log(`PASS  ${name}${extra ? `  (${extra})` : ""}`);
}
function fail(name, err) {
  results.push({ name, ok: false });
  console.log(`FAIL  ${name}  ${err?.stack || err}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function testButtonConstants() {
  // Standard XUSB values — Windows games depend on these exact bits.
  assert(GAMEPAD_BUTTONS.up === 0x0001, "dpad up");
  assert(GAMEPAD_BUTTONS.down === 0x0002, "dpad down");
  assert(GAMEPAD_BUTTONS.left === 0x0004, "dpad left");
  assert(GAMEPAD_BUTTONS.right === 0x0008, "dpad right");
  assert(GAMEPAD_BUTTONS.start === 0x0010, "start");
  assert(GAMEPAD_BUTTONS.back === 0x0020, "back");
  assert(GAMEPAD_BUTTONS.lb === 0x0100, "lb");
  assert(GAMEPAD_BUTTONS.rb === 0x0200, "rb");
  assert(GAMEPAD_BUTTONS.guide === 0x0400, "guide");
  assert(GAMEPAD_BUTTONS.a === 0x1000, "a");
  assert(GAMEPAD_BUTTONS.b === 0x2000, "b");
  assert(GAMEPAD_BUTTONS.x === 0x4000, "x");
  assert(GAMEPAD_BUTTONS.y === 0x8000, "y");
  pass("XUSB button bits match XInput");
}

function testNormalize() {
  const z = normalizeGamepadState(undefined);
  assert(sameGamepadState(z, zeroGamepadState()), "garbage normalizes to zero, never throws");
  const full = normalizeGamepadState({
    buttons: 0xf000,
    btn: { a: true, b: false },
    lt: 1,
    rt: 128,
    lx: -1,
    ly: 0.5,
    rx: 32767,
    ry: -32768,
  });
  assert(full.buttons === 0xd000, `btn map merges over bitmask (${full.buttons.toString(16)})`);
  assert(normalizeGamepadState({ buttons: 0xf000 }).buttons === 0xf000, "bitmask passthrough");
  assert(full.lt === 255, "trigger float 1 -> 255");
  assert(full.rt === 128, "trigger int passthrough");
  assert(full.lx === -32768, "axis float -1 -> min");
  assert(full.ly === 16384, `axis float 0.5 -> 16384 (got ${full.ly})`);
  assert(full.rx === 32767 && full.ry === -32768, "axis int passthrough");
  const clear = normalizeGamepadState({ buttons: 0xffff, btn: { a: false, guide: false } });
  assert(clear.buttons === (0xffff & ~0x1000 & ~0x0400), "btn:false clears bits");
  const clamp = normalizeGamepadState({ lt: 999, rt: -3, lx: 99999, rx: -99999, buttons: 1e9 });
  assert(clamp.lt === 255 && clamp.rt === 0, "triggers clamp");
  assert(clamp.lx === 32767 && clamp.rx === -32768, "axes clamp");
  assert(clamp.buttons === 0xffff, "buttons clamp");
  assert(normalizeGamepadState({ lx: 0.001 }).lx === 0, "center snap avoids drift");
  pass("gamepad state normalization + clamping");
}

async function testWatchdogAndReset() {
  resetBackendCache();
  const session = createGamepadSession({ watchdogMs: 300 });
  const before = backendStatus();
  assert(before.ok === false, "no backend cached before first update");
  const res = await session.update({ btn: { a: true }, lx: 1, rt: 1 });
  // With the bundled DLL + a bus driver present this succeeds; without a
  // driver it must fail with a clean ViGEm error (never throws, never hangs).
  const unavailable = res.ok === false && /ViGEm/i.test(res.error || "");
  assert(res.ok === true || unavailable, `update resolves cleanly (got: ${JSON.stringify(res)})`);
  assert(session.status().state.buttons === GAMEPAD_BUTTONS.a, "latest state kept");
  await wait(800); // watchdog (300ms) must have zeroed the stuck A press
  assert(sameGamepadState(session.status().state, zeroGamepadState()), "watchdog zeroes stuck inputs");
  await session.close();
  await session.close(); // idempotent
  assert(session.status().closed, "session closed");
  pass("watchdog reset + disconnect teardown");
}

function testRoutingGuard() {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
  for (const token of ['case "gamepad":', 'case "gamepadEnd":', "createGamepadSession"]) {
    assert(src.includes(token), `index.js wires ${token}`);
  }
  for (const token of ["gameAudio", "gameaudio", "wasapi", "/audio"]) {
    assert(!src.includes(token), `audio fully removed from index.js (${token})`);
  }
  // Protected handlers must still be exactly where they were.
  for (const token of [
    'case "move":', 'case "click":', 'case "scroll":', 'case "abs":', 'case "drag":',
    'case "key":', 'case "combo":', 'case "text":', 'case "media":', 'case "lock":',
    'case "open":', 'case "monitor":', 'case "quality":', 'case "crop":', 'case "cam":',
    'case "ping":', 'case "clipboard":',
  ]) {
    assert(src.includes(token), `protected handler intact: ${token}`);
  }
  pass("GAME routing present, protected handlers intact");
}

try {
  testButtonConstants();
  testNormalize();
  await testWatchdogAndReset();
  testRoutingGuard();
} catch (err) {
  fail("game suite", err);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} game tests passed`);
if (failed.length) process.exit(1);
