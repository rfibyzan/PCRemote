// Run: node src/waituntil.test.js
import { waitUntil } from "./waituntil.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log("FAIL", name);
  }
}

function fakeBus() {
  const bus = { cb: null, subs: 0, unsubs: 0 };
  bus.subscribe = (cb) => {
    bus.subs += 1;
    bus.cb = cb;
    return () => {
      bus.unsubs += 1;
      bus.cb = null;
    };
  };
  return bus;
}
const base = (bus, extra = {}) => ({
  isReady: () => false,
  subscribe: bus.subscribe,
  match: (e) => e.t === "hello",
  timeoutMs: 30,
  timeoutMessage: "habis",
  ...extra,
});

async function main() {
  {
    const bus = fakeBus();
    await waitUntil(base(bus, { isReady: () => true }));
    ok(bus.subs === 0, "resolves at once when ready");
  }
  {
    const bus = fakeBus();
    const p = waitUntil(base(bus));
    bus.cb({ t: "hello" });
    await p;
    ok(bus.unsubs === 1, "resolves on matching event");
  }
  {
    const bus = fakeBus();
    let done = false;
    const p = waitUntil(base(bus)).then(() => (done = true));
    bus.cb({ t: "close" });
    await Promise.resolve();
    const early = done;
    bus.cb({ t: "hello" });
    await p;
    ok(!early && done, "ignores unrelated events");
  }
  {
    const bus = fakeBus();
    let msg = "";
    await waitUntil(base(bus)).catch((e) => (msg = e.message));
    ok(msg === "habis" && bus.unsubs === 1, "rejects after timeout and unsubscribes");
  }
  console.log(`${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}
main();
