// node src/pointer_test.js (pure, runs anywhere)
import { INJECT_GRACE_MS, LOCAL_HOLD_MS, createPresence, presenceStep, shapeOf } from "./pointerstate.js";
let n = 0;
let ok = 0;
const t = (name, got, want) => {
  n += 1;
  if (got === want) ok += 1;
  else console.log("FAIL", name, JSON.stringify(got), "!=", JSON.stringify(want));
};
const st = createPresence();
t("first sample is not local", presenceStep(st, { x: 10, y: 10 }, 1000, 0).local, false);
t("phone move (just injected) is not local", presenceStep(st, { x: 200, y: 10 }, 2000, 1900).local, false);
t("still not local", presenceStep(st, { x: 200, y: 10 }, 2100, 1900).local, false);
t("physical move is local", presenceStep(st, { x: 300, y: 50 }, 2000 + INJECT_GRACE_MS + 500, 1900).local, true);
t("stays local while idle", presenceStep(st, { x: 300, y: 50 }, 3500, 1900).local, true);
t("fades after hold", presenceStep(st, { x: 300, y: 50 }, 2850 + LOCAL_HOLD_MS + 10, 1900).local, false);
t("1px jitter ignored", presenceStep(createPresence(), { x: 5, y: 5 }, 0, 0) && presenceStep(st, { x: 301, y: 50 }, 9000, 0).local, false);
const table = new Map([["111", "text"], ["222", "hand"]]);
t("hidden cursor", shapeOf(false, "111", table), "none");
t("known shape", shapeOf(true, "222", table), "hand");
t("custom app cursor falls back to arrow", shapeOf(true, "999", table), "arrow");
console.log(`${ok}/${n} pointer tests passed`);
if (ok !== n) process.exit(1);

// ---- update check (pure parts)
const { compareVersions, newerRelease } = await import("./updates.js");
let un = 0;
let uok = 0;
const u = (name, got, want) => {
  un += 1;
  if (JSON.stringify(got) === JSON.stringify(want)) uok += 1;
  else console.log("FAIL", name, JSON.stringify(got), "!=", JSON.stringify(want));
};
u("newer minor", compareVersions("v1.3.0", "v1.2.9"), 1);
u("equal", compareVersions("1.2.0", "v1.2"), 0);
u("older", compareVersions("v1.2.0", "v1.10.0"), -1);
u("newer release", newerRelease("v1.0.0", { tag_name: "v1.1.0", html_url: "https://x/r" }), { tag: "v1.1.0", url: "https://x/r" });
u("same release", newerRelease("v1.1.0", { tag_name: "v1.1.0" }), null);
u("dev checkout never nags", newerRelease("", { tag_name: "v9.0.0" }), null);
u("prerelease ignored", newerRelease("v1.0.0", { tag_name: "v2.0.0", prerelease: true }), null);
console.log(`${uok}/${un} update tests passed`);
if (uok !== un) process.exit(1);
