import { SENTINELS, chordKey, diffInput, liveDiff, nextSentinel, pushRecent } from "./typediff.js";
let fail = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fail++; console.log("FAIL", m, JSON.stringify(a)); } else console.log("PASS", m); };
const S = SENTINELS[0];
eq(diffInput(S, S + "a"), { removed: 0, added: "a" }, "type a");
eq(diffInput(S, S + "hello"), { removed: 0, added: "hello" }, "burst");
eq(diffInput(S, S.slice(0, -1)), { removed: 1, added: "" }, "backspace on sentinel");
eq(diffInput(S, ""), { removed: S.length, added: "" }, "select-all delete");
eq(diffInput(S, S + "\n"), { removed: 0, added: "\n" }, "newline");
eq(SENTINELS[0] !== SENTINELS[1] && SENTINELS[0].length === SENTINELS[1].length, true, "sentinels alternate, same length");
eq(chordKey("/"), "/", "slash chord");
eq(chordKey("C"), "c", "letter chord lowercased");
eq(chordKey("?"), null, "shifted symbol no chord");
eq(chordKey("ab"), null, "multi char no chord");
eq(pushRecent("dun", "ia", 0), "dunia", "recent append");
eq(pushRecent("dunia", "", 2), "dun", "recent backspace");
eq(pushRecent("abcdefgh", "ij", 0), "cdefghij", "recent capped");
const [A, B] = SENTINELS;
eq(liveDiff(A, A + "f", B), { removed: 0, added: "f" }, "live: normal key");
eq(liveDiff(A + "f", A + "fa", B), { removed: 0, added: "a" }, "live: reset not landed yet");
eq(liveDiff(A + "f", B + "a", B), { removed: 0, added: "a" }, "live: reset landed, next key");
eq(liveDiff(A + "f", A, B), { removed: 1, added: "" }, "live: backspace before reset");
eq(liveDiff(A, A.slice(0, -1), B), { removed: 1, added: "" }, "live: backspace on sentinel");
eq(liveDiff(A.slice(0, -1), B.slice(0, -1), B), { removed: 1, added: "" }, "live: 2nd backspace after silent reset");
eq(nextSentinel(A + "x"), B, "next sentinel flips base");
eq(nextSentinel(B.slice(0, -1)), A, "next sentinel flips base back");
eq(nextSentinel(""), A, "next sentinel from empty");

// Simulated hidden field: keys, backspaces, and resets that land late or
// never; the PC must end with exactly what the user meant.
function sim(steps) {
  let native = A, last = A, sent = B, pc = "";
  for (const st of steps) {
    if (st === "<reset") { native = sent; continue; }
    if (st === "BS") { if (!native) continue; native = native.slice(0, -1); } else native += st;
    const { removed, added } = liveDiff(last, native, sent);
    pc = pc.slice(0, Math.max(0, pc.length - removed)) + added;
    last = native;
    sent = nextSentinel(native);
  }
  return pc;
}
const now = (keys) => keys.flatMap((k) => [k, "<reset"]);
eq(sim(now(["g", "i", "t", "BS", "BS", "BS"])), "", "sim: git + 3 backspace");
eq(sim(now(["g", "i", "t", "BS", "BS"])), "g", "sim: git + 2 backspace");
eq(sim(["f", "a", "<reset", "r", "h", "a", "<reset", "n"]), "farhan", "sim: farhan with lag");
eq(sim(["g", "i", "t", "BS", "BS", "BS", "<reset"]), "", "sim: backspaces before reset");
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let bad = 0;
for (let t = 0; t < 20000; t += 1) {
  const steps = []; let want = "";
  for (let i = 0; i < 14; i += 1) {
    if (rnd() < 0.5) steps.push("<reset");
    if (rnd() < 0.4) { steps.push("BS"); want = want.slice(0, -1); } else { const c = "abc"[i % 3]; steps.push(c); want += c; }
  }
  if (sim(steps) !== want) bad += 1;
}
eq(bad, 0, "sim: 20000 random lag sequences");
if (fail) { console.log(fail, "failed"); process.exit(1); }
console.log("typediff tests passed");
