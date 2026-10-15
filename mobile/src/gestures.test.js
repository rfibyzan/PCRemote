// node src/gestures.test.js
import { centroid, gestureFor, swipeDir } from "./gestures.js";
let ok = 0;
let n = 0;
const t = (name, cond, got) => {
  n += 1;
  if (cond) ok += 1;
  else console.log("FAIL", name, JSON.stringify(got));
};
const c = centroid([{ pageX: 0, pageY: 0 }, { pageX: 30, pageY: 60 }, { pageX: 60, pageY: 0 }]);
t("centroid", c.x === 30 && c.y === 20, c);
t("centroid empty", centroid([]) === null, centroid([]));
t("short swipe ignored", swipeDir(40, 0) === "", swipeDir(40, 0));
t("diagonal ignored", swipeDir(80, 75) === "", swipeDir(80, 75));
t("up", swipeDir(5, -90) === "up", swipeDir(5, -90));
t("down", swipeDir(-10, 70) === "down", swipeDir(-10, 70));
t("left", swipeDir(-80, 10) === "left", swipeDir(-80, 10));
t("right", swipeDir(100, -20) === "right", swipeDir(100, -20));
t("3 up = Task View", gestureFor(3, "up").keys.join("+") === "win+tab", gestureFor(3, "up"));
t("3 down = Win+D", gestureFor(3, "down").keys.join("+") === "win+d", gestureFor(3, "down"));
t("3 right = Alt+Tab", gestureFor(3, "right").keys.join("+") === "alt+tab", gestureFor(3, "right"));
t("3 left = Alt+Shift+Tab", gestureFor(3, "left").keys.join("+") === "alt+shift+tab", gestureFor(3, "left"));
t("4 right = next desktop", gestureFor(4, "right").keys.join("+") === "ctrl+win+right", gestureFor(4, "right"));
t("5 fingers count as 4", gestureFor(5, "left").keys.join("+") === "ctrl+win+left", gestureFor(5, "left"));
t("2 fingers = none", gestureFor(2, "up") === null, gestureFor(2, "up"));
console.log(`${ok}/${n} gestures tests passed`);
if (ok !== n) process.exit(1);
