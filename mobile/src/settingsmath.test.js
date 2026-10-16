import assert from "node:assert/strict";
import { planSync } from "./settingsmath.js";

// fresh install: PC value applied
let p = planSync({ keys: ["shortcuts"], remote: { shortcuts: { v: [1], ts: 5 } }, full: true });
assert.deepEqual(p.apply.shortcuts, { v: [1], ts: 5 });
// phone newer: push
p = planSync({ keys: ["q"], remote: { q: { v: 1, ts: 5 } }, localTs: { q: 9 }, full: true });
assert.deepEqual(p.push.q, { ts: 9 });
assert.equal(p.apply.q, undefined);
// PC empty, local value never stamped: push with now
p = planSync({ keys: ["q", "x"], remote: {}, localValues: { q: { a: 1 }, x: null }, full: true, now: 42 });
assert.deepEqual(p.push.q, { v: { a: 1 }, ts: 42 });
assert.equal(p.push.x, undefined);
// partial broadcast never pushes missing keys
p = planSync({ keys: ["q"], remote: {}, localTs: { q: 3 }, full: false });
assert.deepEqual(p.push, {});
// equal ts: nothing
p = planSync({ keys: ["q"], remote: { q: { v: 1, ts: 3 } }, localTs: { q: 3 }, full: true });
assert.deepEqual(p, { apply: {}, push: {} });
console.log("settingsmath ok");
