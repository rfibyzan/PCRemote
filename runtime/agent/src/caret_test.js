// Run: node src/caret_test.js
import { createCaretWatch } from "./caret.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log("FAIL", name);
  }
}

const MON = { left: 0, top: 0, w: 1000, h: 1000 };
function rig({ win32 = () => null, uiaRead = async () => null } = {}) {
  const r = { sent: [], t: 0, timer: null, uiaCalls: 0, stopped: 0 };
  r.watch = createCaretWatch({
    send: (ws, m) => r.sent.push({ ws, m }),
    monitorFor: () => MON,
    readWin32: () => win32(),
    uia: {
      read: () => {
        r.uiaCalls += 1;
        return uiaRead();
      },
      stop: () => (r.stopped += 1),
    },
    now: () => r.t,
    setTimer: (fn) => (r.timer = fn),
    clearTimer: () => (r.timer = null),
  });
  return r;
}
const A = { id: "A" };
const B = { id: "B" };
const RECT = { x: 100, y: 200, w: 1, h: 20 };

async function main() {
  {
    const r = rig({ win32: () => RECT });
    r.watch.set(A, true);
    await r.watch.tick();
    r.t += 100;
    await r.watch.tick();
    ok(r.sent.length === 1 && r.sent[0].m.t === "caret" && r.sent[0].m.x === 0.1, "dedupes identical caret");
  }
  {
    const r = rig();
    r.watch.set(A, true);
    await r.watch.tick();
    r.t += 300;
    await r.watch.tick();
    ok(r.sent.length === 1 && r.sent[0].m.none === true, "sends none once");
  }
  {
    const r = rig({ win32: () => null, uiaRead: async () => RECT });
    r.watch.set(A, true);
    await r.watch.tick(); // t=0 -> uia
    r.t = 100;
    await r.watch.tick(); // too soon -> cached
    r.t = 200;
    await r.watch.tick();
    ok(r.uiaCalls === 1, "uses uia not more often than 250ms");
    ok(r.sent.length === 1 && r.sent[0].m.x === 0.1, "cached uia rect does not flap to none");
    r.t = 260;
    await r.watch.tick();
    ok(r.uiaCalls === 2, "uia asked again after 250ms");
  }
  {
    const r = rig({ win32: () => RECT });
    r.watch.set(A, true);
    await r.watch.tick();
    ok(r.uiaCalls === 0, "uses uia only when win32 empty");
  }
  {
    const r = rig({ uiaRead: async () => Promise.reject(new Error("dead")) });
    r.watch.set(A, true);
    let threw = false;
    await r.watch.tick().catch(() => (threw = true));
    ok(!threw && r.sent[0]?.m.none === true, "uia reader failure is swallowed");
  }
  {
    const r = rig({ win32: () => RECT });
    r.watch.set(A, true);
    r.watch.set(B, false);
    await r.watch.tick();
    ok(r.sent.length === 1 && r.sent[0].ws === A, "per connection");
    ok(typeof r.timer === "function", "timer runs while someone watches");
    r.watch.set(B, true);
    await r.watch.tick();
    ok(r.sent.length === 2 && r.sent[1].ws === B, "new watcher gets the current caret");
    r.watch.drop(A);
    r.watch.drop(B);
    ok(r.timer === null && r.stopped === 1, "drop stops timer and uia");
  }
  {
    const r = rig({ win32: () => RECT });
    r.watch.set(A, true);
    await r.watch.tick();
    r.watch.set(A, false);
    r.watch.set(A, true);
    await r.watch.tick();
    ok(r.sent.length === 2, "re-enabling resends the current caret");
  }
  {
    // UIA timeout (no answer) must keep the last rect, not flap to none.
    let next = RECT;
    const r = rig({ uiaRead: async () => next });
    r.watch.set(A, true);
    await r.watch.tick();
    next = undefined;
    r.t = 300;
    await r.watch.tick();
    ok(r.sent.length === 1 && r.sent[0].m.x === 0.1, "uia timeout keeps the last rect");
  }
  console.log(`${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}
main();
