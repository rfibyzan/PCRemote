// node src/scrollmath.test.js
import { DEFAULT_SCROLL, NOTCH, clampThumb, flingStep, makeNotchCounter, normScroll, wheelFromSwipe } from "./scrollmath.js";
let n = 0, ok = 0;
function t(name, cond, info) { n++; if (cond) ok++; else console.log("FAIL", name, JSON.stringify(info)); }
const nat = { natural: true, speed: 2 }, inv = { natural: false, speed: 2 };
t("default is natural", DEFAULT_SCROLL.natural === true && normScroll(null).natural === true);
t("natural: finger up -> wheel down (content follows finger)", wheelFromSwipe(0, -10, nat, 5).dy === -50, wheelFromSwipe(0, -10, nat, 5));
t("natural: finger down -> wheel up", wheelFromSwipe(0, 10, nat, 5).dy === 50);
t("inverse: finger up -> wheel up (old behaviour)", wheelFromSwipe(0, -10, inv, 5).dy === 50);
t("natural horizontal: finger right -> view left", wheelFromSwipe(10, 0, nat, 1).dx === 10);
t("inverse horizontal = old touchpad sign", wheelFromSwipe(10, 0, inv, 1).dx === -10);
t("speed scales", wheelFromSwipe(0, -10, { natural: true, speed: 4 }, 5).dy === -100 && wheelFromSwipe(0, -10, { natural: true, speed: 0 }, 5).dy === -25);
t("speed clamps", normScroll({ speed: 99 }).speed === 4 && normScroll({ speed: -3 }).speed === 0 && normScroll({ speed: "x" }).speed === 2);
const c = makeNotchCounter();
t("no notch below 120", c.add(100) === 0);
t("one notch at 120", c.add(30) === 1);
t("two notches back", c.add(-250) === -2, c);
t("fling decays to 0", (() => { let v = 2, i = 0; while (v && i < 500) { v = flingStep(v); i++; } return v === 0 && i < 200; })());
t("thumb clamps", clampThumb(500, 300, 60) === 120 && clampThumb(-500, 300, 60) === -120 && clampThumb(10, 300, 60) === 10);
t("NOTCH", NOTCH === 120);
console.log(`${ok}/${n} ok`);
if (ok !== n) process.exit(1);
