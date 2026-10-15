// node src/pointer.test.js
import { pointerIcon } from "./pointer.js";
let n = 0;
let ok = 0;
const t = (name, got, want) => {
  n += 1;
  if (got === want) ok += 1;
  else console.log("FAIL", name, got, "!=", want);
};
t("arrow = bare ring", pointerIcon("arrow"), "");
t("hidden = bare ring", pointerIcon("none"), "");
t("unknown/old agent", pointerIcon(undefined), "");
t("text", pointerIcon("text"), "cursor-text");
t("hand", pointerIcon("hand"), "cursor-pointer");
t("resize", pointerIcon("ew"), "arrow-left-right");
console.log(`${ok}/${n} pointer tests passed`);
if (ok !== n) process.exit(1);
