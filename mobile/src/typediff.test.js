import { SENTINELS, chordKey, diffInput, pushRecent } from "./typediff.js";
let fail = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fail++; console.log("FAIL", m, JSON.stringify(a)); } else console.log("PASS", m); };
const S = SENTINELS[0];
eq(diffInput(S, S + "a"), { removed: 0, added: "a" }, "type a");
eq(diffInput(S, S + "hello"), { removed: 0, added: "hello" }, "burst");
eq(diffInput(S, S.slice(0, 1)), { removed: 1, added: "" }, "backspace on sentinel");
eq(diffInput(S, ""), { removed: 2, added: "" }, "select-all delete");
eq(diffInput(S, S + "\n"), { removed: 0, added: "\n" }, "newline");
eq(SENTINELS[0] !== SENTINELS[1] && SENTINELS[0].length === SENTINELS[1].length, true, "sentinels alternate, same length");
eq(chordKey("/"), "/", "slash chord");
eq(chordKey("C"), "c", "letter chord lowercased");
eq(chordKey("?"), null, "shifted symbol no chord");
eq(chordKey("ab"), null, "multi char no chord");
eq(pushRecent("dun", "ia", 0), "dunia", "recent append");
eq(pushRecent("dunia", "", 2), "dun", "recent backspace");
eq(pushRecent("abcdefgh", "ij", 0), "cdefghij", "recent capped");
if (fail) { console.log(fail, "failed"); process.exit(1); }
console.log("typediff tests passed");
