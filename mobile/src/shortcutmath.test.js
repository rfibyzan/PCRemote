import assert from "node:assert/strict";
import { cleanShortcuts, comboKeys, comboLabel, moveShortcut, removeShortcut, upsertShortcut } from "./shortcutmath.js";

const listary = { id: "a", name: "Listary", mods: ["alt", "ctrl", "shift"], key: "/" };
assert.deepEqual(comboKeys(listary), ["ctrl", "shift", "alt", "/"]);
assert.equal(comboLabel(listary), "Ctrl+Shift+Alt+/");
assert.equal(comboLabel({ mods: ["win", "shift"], key: "s" }), "Shift+Win+S");
assert.equal(comboLabel({ mods: ["ctrl"], key: "f4" }), "Ctrl+F4");
// invalid key dropped, duplicate id dropped, empty name gets combo label
const l = cleanShortcuts([listary, { id: "b", mods: [], key: "!!" }, { id: "a", key: "x" }, { id: "c", mods: ["win"], key: "." }]);
assert.deepEqual(l.map((s) => s.id), ["a", "c"]);
assert.equal(l[1].name, "Win+.");
let m = upsertShortcut(l, { id: "c", name: "Emoji", mods: ["win"], key: "." });
assert.equal(m[1].name, "Emoji");
m = upsertShortcut(m, { id: "d", name: "Snip", mods: ["win", "shift"], key: "s" });
assert.equal(m.length, 3);
assert.deepEqual(moveShortcut(m, "d", -1).map((s) => s.id), ["a", "d", "c"]);
assert.deepEqual(moveShortcut(m, "a", -1).map((s) => s.id), ["a", "c", "d"]);
assert.deepEqual(removeShortcut(m, "a").map((s) => s.id), ["c", "d"]);
console.log("shortcutmath ok");
