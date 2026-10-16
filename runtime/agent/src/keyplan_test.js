import { forceUnicode, planChar } from "./keyplan.js";
let fail = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fail++; console.log("FAIL", m, JSON.stringify(a)); } else console.log("PASS", m); };
// US layout VkKeyScanW values
eq(planChar("/", 0x00bf), { vk: 0xbf, shift: false }, "slash");
eq(planChar("?", 0x01bf), { vk: 0xbf, shift: true }, "question = shift+/");
eq(planChar("a", 0x0041), { vk: 0x41, shift: false }, "a");
eq(planChar("A", 0x0141), { vk: 0x41, shift: true }, "A");
eq(planChar("a", 0x0041, true), { vk: 0x41, shift: true }, "a with caps -> shift");
eq(planChar("A", 0x0141, true), { vk: 0x41, shift: false }, "A with caps -> no shift");
eq(planChar("1", 0x0031, true), { vk: 0x31, shift: false }, "digits ignore caps");
eq(planChar("é", -1), null, "not on layout");
eq(planChar("é", 0xffff), null, "not on layout (uint16)");
eq(planChar("€", 0x0645), null, "AltGr char -> unicode");
eq(forceUnicode("😀"), true, "emoji unicode");
eq(forceUnicode("a"), false, "a not forced");
if (fail) { console.log(fail, "keyplan tests failed"); process.exit(1); }
console.log("keyplan tests passed");
