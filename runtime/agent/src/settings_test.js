import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore, mergeSettings } from "./settings.js";

// newest wins, older ignored, bad keys dropped
let r = mergeSettings({}, { shortcuts: { v: [1], ts: 10 }, "bad key": { v: 1, ts: 5 }, x: { v: 1 } });
assert.deepEqual(Object.keys(r.changed), ["shortcuts"]);
r = mergeSettings(r.items, { shortcuts: { v: [2], ts: 9 } });
assert.deepEqual(r.changed, {});
assert.deepEqual(r.items.shortcuts.v, [1]);
r = mergeSettings(r.items, { shortcuts: { v: [3], ts: 11 } });
assert.deepEqual(r.items.shortcuts.v, [3]);
// oversized value refused
r = mergeSettings({}, { big: { v: "x".repeat(70 * 1024), ts: 1 } });
assert.deepEqual(r.changed, {});

// store persists to disk
const file = join(mkdtempSync(join(tmpdir(), "pcr-set-")), "settings.json");
const st = createSettingsStore(file);
st.apply({ quality: { v: { q: "high" }, ts: 100 } });
const disk = JSON.parse(readFileSync(file, "utf8"));
assert.equal(disk.items.quality.v.q, "high");
assert.equal(createSettingsStore(file).all().quality.ts, 100);
console.log("settings_test ok");
