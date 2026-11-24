// node src/clipsync_test.js
import { CLIP_MAX, createClipSync, normClip, shouldPush } from "./clipsync.js";

let n = 0, ok = 0;
function t(name, cond, info) { n++; if (cond) ok++; else console.log("FAIL", name, JSON.stringify(info)); }

t("trailing newline from PowerShell removed", normClip("halo\r\n") === "halo");
t("only one newline removed", normClip("a\n\n") === "a\n");
t("capped", normClip("x".repeat(CLIP_MAX + 5)).length === CLIP_MAX);
t("null safe", normClip(null) === "");
t("empty never pushed", !shouldPush("", null));
t("echo never pushed", !shouldPush("abc", "abc"));
t("new text pushed", shouldPush("abc", "ab"));

// Phone -> PC: written, relayed to the OTHER syncing phone only, no bounce.
const sent = [];
let seq = 1;
let pcText = "";
const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
const sync = createClipSync({
  clients: () => [a, b, c],
  send: (ws, m) => sent.push([ws.id, m.s]),
  readSeq: () => seq,
  readText: async () => pcText,
  writeText: async (s) => { pcText = s; seq += 1; },
});
sync.setWanted(a, true);
sync.setWanted(b, true);
await sync.fromPhone(a, "dari HP\n");
t("PC clipboard set", pcText === "dari HP", pcText);
t("relayed to b only (c not syncing, a is the source)", JSON.stringify(sent) === JSON.stringify([["b", "dari HP"]]), sent);
await sync.fromPhone(b, "dari HP");
t("same text again is ignored", sent.length === 1, sent);
sync.stop();
console.log(`${ok}/${n} clipsync tests passed`);
if (ok !== n) process.exit(1);
