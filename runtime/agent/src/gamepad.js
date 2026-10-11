/**
 * GAME virtual Xbox 360 controller backend (Phase 2A/2B).
 *
 * Isolated module: nothing in PAD / Q / TYPE / WEBCAM / WIN imports this file.
 * The agent boots and runs identically with or without ViGEmBus installed —
 * the ViGEmClient.dll backend is resolved lazily on first use, and every
 * failure degrades to a clean `{ ok: false, error }` instead of throwing.
 *
 * Wire protocol (additive JSON messages on the EXISTING WebSocket connection;
 * existing handlers in index.js are untouched):
 *
 *   Client -> agent  { t: "gamepad", state: {...} }   full controller state
 *   Client -> agent  { t: "gamepadEnd" }              release + reset + detach
 *   Agent  -> client { t: "gamepad", on: true }       virtual pad attached
 *   Agent  -> client { t: "gamepad", on: false, error } backend unavailable
 *
 * `state` fields (all optional; missing fields keep their previous value
 * client-side — the AGENT treats every update as the full latest state):
 *   buttons: uint16 bitmask using GAMEPAD_BUTTONS below, and/or
 *   btn:     { a,b,x,y,lb,rb,ltBtn..., back,start,guide,
 *              up,down,left,right, l3,r3 } booleans merged over `buttons`
 *   lt, rt:  0..1 float or 0..255 int
 *   lx,ly,rx,ry: -1..1 float (client applies deadzone + smoothing) or
 *              -32768..32767 int. NOTE: +ly = UP to match XInput; the mobile
 *              client flips its screen-space Y before sending.
 *
 * GAME screen/quality uses the EXISTING `quality` message + binary frame
 * channel, so no new encoder exists. Suggested client mapping:
 *   Low  -> { q: "low",  fps: 15 }   Mid -> { q: "low", fps: 20 }
 *   High -> { q: "high", fps: 30 }   (plus optional width/jpeg/viewPx caps)
 *
 * Safety: each session owns a watchdog. If no update arrives within
 * WATCHDOG_MS the zero state is pushed once (prevents stuck inputs).
 * close()/gamepadEnd/ws-close always pushes zero, then detaches the target.
 */

export const GAMEPAD_BUTTONS = {
  up: 0x0001,
  down: 0x0002,
  left: 0x0004,
  right: 0x0008,
  start: 0x0010,
  back: 0x0020,
  l3: 0x0040,
  r3: 0x0080,
  lb: 0x0100,
  rb: 0x0200,
  guide: 0x0400,
  a: 0x1000,
  b: 0x2000,
  x: 0x4000,
  y: 0x8000,
};

export const WATCHDOG_MS = 2000;
// ViGEm reports success as VIGEM_ERROR_NONE (0x20000000), NOT zero.
// See ViGEmClient include/ViGEm/Client.h: VIGEM_SUCCESS(v) == (v == NONE).
export const VIGEM_OK = 0x20000000;
const AXIS_MAX = 32767;
const AXIS_MIN = -32768;

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

function normTrigger(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) n = 0;
  // 0..1 float form vs 0..255 int form.
  const as255 = n <= 1 ? n * 255 : n;
  return Math.max(0, Math.min(255, Math.round(as255)));
}

function normAxis(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n >= -1 && n <= 1) {
    // Normalized float form. Snap a hair around center to avoid drift.
    if (Math.abs(n) < 0.004) return 0;
    return Math.round(n * (n < 0 ? -AXIS_MIN : AXIS_MAX));
  }
  return clampInt(n, AXIS_MIN, AXIS_MAX);
}

/** Pure: validate + normalize any client-supplied state. Never throws. */
export function normalizeGamepadState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  let buttons = clampInt(src.buttons, 0, 0xffff);
  const btn = src.btn && typeof src.btn === "object" ? src.btn : {};
  for (const [name, bit] of Object.entries(GAMEPAD_BUTTONS)) {
    if (btn[name]) buttons |= bit;
    else if (btn[name] === false) buttons &= ~bit;
  }
  return {
    buttons: buttons & 0xffff,
    lt: normTrigger(src.lt),
    rt: normTrigger(src.rt),
    lx: normAxis(src.lx),
    ly: normAxis(src.ly),
    rx: normAxis(src.rx),
    ry: normAxis(src.ry),
  };
}

export function zeroGamepadState() {
  return { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
}

export function sameGamepadState(a, b) {
  return (
    a.buttons === b.buttons &&
    a.lt === b.lt &&
    a.rt === b.rt &&
    a.lx === b.lx &&
    a.ly === b.ly &&
    a.rx === b.rx &&
    a.ry === b.ry
  );
}

// ---------------------------------------------------------------------------
// Lazy ViGEm backend. Everything driver-specific lives behind getBackend(),
// which never throws — it caches { ok, error, ... } on first attempt.
// ---------------------------------------------------------------------------

let backendCache = null;

function failBackend(error) {
  backendCache = { ok: false, error: String(error?.message || error || "ViGEmBus unavailable") };
  return backendCache;
}

export function resetBackendCache() {
  backendCache = null;
}

export function backendStatus() {
  return backendCache
    ? { ok: backendCache.ok, error: backendCache.error || "" }
    : { ok: false, error: "", attempted: false };
}

async function getBackend() {
  if (backendCache) return backendCache;
  if (process.platform !== "win32") return failBackend("gamepad needs Windows + ViGEmBus");
  let koffi;
  try {
    ({ default: koffi } = await import("koffi"));
  } catch (err) {
    return failBackend(`koffi unavailable: ${err?.message || err}`);
  }
  try {
    const XUSB_REPORT = koffi.struct("GAME_XUSB_REPORT", {
      wButtons: "uint16",
      bLeftTrigger: "uint8",
      bRightTrigger: "uint8",
      sThumbLX: "int16",
      sThumbLY: "int16",
      sThumbRX: "int16",
      sThumbRY: "int16",
    });
    // Moonlight-style: prefer our bundled ViGEmClient.dll (ships with the
    // agent folder, MIT-licensed, see ViGEmClient.LICENSE.txt) before the
    // system path, so no separate install is needed.
    const { dirname, join } = await import("node:path");
    const { existsSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const isDll = (p) => {
      try {
        return Boolean(p) && existsSync(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    };
    const here = dirname(fileURLToPath(import.meta.url));
    const bundled = [
      process.env.VIGEMCLIENT_PATH,
      join(here, "..", "ViGEmClient.dll"),
      join(dirname(process.execPath), "ViGEmClient.dll"),
      join(dirname(process.execPath), "..", "ViGEmClient.dll"),
      join(process.cwd(), "ViGEmClient.dll"),
      join(process.cwd(), "..", "ViGEmClient.dll"),
    ].filter(Boolean).find(isDll);
    let lib;
    let libErr = null;
    if (bundled) {
      try {
        lib = koffi.load(bundled);
      } catch (err) {
        libErr = err;
      }
    }
    if (!lib) {
      try {
        lib = koffi.load("ViGEmClient.dll");
      } catch (err) {
        libErr = libErr || err;
        throw new Error(
          "ViGEmBus client not found (looked next to the agent and on PATH). " +
          `Reinstall PC Remote so ViGEmClient.dll ships with it. (${libErr?.message || libErr || err?.message || err})`,
        );
      }
    }
    const vigem_alloc = lib.func("void* __cdecl vigem_alloc()");
    const vigem_connect = lib.func("int __cdecl vigem_connect(void* bus)");
    const vigem_disconnect = lib.func("void __cdecl vigem_disconnect(void* bus)");
    const vigem_free = lib.func("void __cdecl vigem_free(void* bus)");
    const x360_alloc = lib.func("void* __cdecl vigem_target_x360_alloc()");
    const target_add = lib.func("int __cdecl vigem_target_add(void* bus, void* target)");
    const target_remove = lib.func("int __cdecl vigem_target_remove(void* bus, void* target)");
    const target_free = lib.func("void __cdecl vigem_target_free(void* target)");
    const x360_update = lib.func("int __cdecl vigem_target_x360_update(void* bus, void* target, GAME_XUSB_REPORT report)");
    const bus = vigem_alloc();
    if (!bus || (typeof bus === "number" && bus === 0)) throw new Error("vigem_alloc failed");
    const connRc = vigem_connect(bus);
    if (connRc !== VIGEM_OK) {
      try {
        vigem_free(bus);
      } catch {
        // ignore secondary failure
      }
      throw new Error(`ViGEmBus connect failed (0x${(connRc >>> 0).toString(16)})`);
    }
    backendCache = {
      ok: true,
      error: "",
      bus,
      fns: { vigem_disconnect, vigem_free, x360_alloc, target_add, target_remove, target_free, x360_update },
    };
    return backendCache;
  } catch (err) {
    return failBackend(err);
  }
}

function toReport(state) {
  return {
    wButtons: state.buttons & 0xffff,
    bLeftTrigger: state.lt,
    bRightTrigger: state.rt,
    sThumbLX: state.lx,
    sThumbLY: state.ly,
    sThumbRX: state.rx,
    sThumbRY: state.ry,
  };
}

/**
 * One virtual Xbox 360 pad. Owns a ViGEm target (when the backend exists),
 * the latest state, and a watchdog that zeroes stuck inputs.
 */
export function createGamepadSession(opts = {}) {
  const watchdogMs = Math.max(250, Number(opts.watchdogMs) || WATCHDOG_MS);
  const session = {
    target: null,
    attached: false,
    last: zeroGamepadState(),
    lastSeen: 0,
    lastError: "",
    closed: false,
    _timer: null,
    _zeroPushed: true,

    async update(raw) {
      if (session.closed) return { ok: false, error: "session closed" };
      session.last = normalizeGamepadState(raw);
      session.lastSeen = Date.now();
      session._zeroPushed = false;
      const be = await getBackend();
      if (!be.ok) {
        session.lastError = be.error;
        return { ok: false, error: be.error };
      }
      try {
        if (!session.attached) {
          const target = be.fns.x360_alloc();
          if (!target || (typeof target === "number" && target === 0)) throw new Error("x360_alloc failed");
          const addRc = be.fns.target_add(be.bus, target);
          if (addRc !== VIGEM_OK) {
            try {
              be.fns.target_free(target);
            } catch {
              // ignore
            }
            throw new Error(`target_add failed (0x${(addRc >>> 0).toString(16)})`);
          }
          session.target = target;
          session.attached = true;
        }
        const rc = be.fns.x360_update(be.bus, session.target, toReport(session.last));
        if (rc !== VIGEM_OK) throw new Error(`x360_update failed (0x${(rc >>> 0).toString(16)})`);
        session.lastError = "";
        return { ok: true, attached: true };
      } catch (err) {
        session.lastError = String(err?.message || err);
        return { ok: false, error: session.lastError };
      }
    },

    /** Push the zero state now (release buttons, center sticks, clear triggers). */
    async reset() {
      session.last = zeroGamepadState();
      session._zeroPushed = true;
      const be = backendCache;
      if (!be?.ok || !session.attached || !session.target) return { ok: be?.ok !== false, pushed: false };
      try {
        be.fns.x360_update(be.bus, session.target, toReport(session.last));
        return { ok: true, pushed: true };
      } catch (err) {
        session.lastError = String(err?.message || err);
        return { ok: false, error: session.lastError };
      }
    },

    async close() {
      if (session.closed) return;
      session.closed = true;
      if (session._timer) clearInterval(session._timer);
      session._timer = null;
      try {
        await session.reset();
      } catch {
        // reset is best-effort on teardown
      }
      const be = backendCache;
      if (be?.ok && session.target) {
        try {
          if (session.attached) be.fns.target_remove(be.bus, session.target);
        } catch {
          // already gone
        }
        try {
          be.fns.target_free(session.target);
        } catch {
          // already gone
        }
      }
      session.target = null;
      session.attached = false;
    },

    status() {
      return {
        attached: session.attached,
        closed: session.closed,
        backend: backendStatus(),
        lastError: session.lastError,
        lastSeen: session.lastSeen,
        state: { ...session.last },
      };
    },
  };

  session._timer = setInterval(() => {
    if (session.closed || session._zeroPushed || !session.lastSeen) return;
    if (Date.now() - session.lastSeen >= watchdogMs) {
      // Connection lost mid-press: zero the pad so nothing stays stuck.
      session.reset().catch(() => {});
    }
  }, Math.min(500, watchdogMs));
  if (typeof session._timer.unref === "function") session._timer.unref();
  return session;
}
