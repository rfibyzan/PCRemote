// node src/windows_test.js (pure)
import { exeName, listable, monitorOfRect, placeWindow } from "./windowmath.js";
let n = 0;
let ok = 0;
const t = (name, got, want) => {
  n += 1;
  if (JSON.stringify(got) === JSON.stringify(want)) ok += 1;
  else console.log("FAIL", name, JSON.stringify(got), "!=", JSON.stringify(want));
};
const mons = [
  { id: 0, left: 0, top: 0, right: 1920, bottom: 1080 },
  { id: 1, left: 1920, top: 0, right: 4480, bottom: 1440 },
];
t("half window on main", placeWindow({ left: 0, top: 0, right: 960, bottom: 1080 }, mons), { mon: 0, x: 0, y: 0, w: 0.5, h: 1 });
t("window on 2nd monitor", placeWindow({ left: 2560, top: 360, right: 3840, bottom: 1080 }, mons), { mon: 1, x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
t("maximized overhang clipped", placeWindow({ left: -8, top: -8, right: 1928, bottom: 1088 }, mons).w, 1);
t("centre decides monitor", monitorOfRect({ left: 1800, top: 0, right: 2400, bottom: 500 }, mons).id, 1);
t("off-screen window", placeWindow({ left: -5000, top: 0, right: -4000, bottom: 500 }, mons), null);
t("listable normal", listable({ visible: true, title: "Chrome", toolWindow: false, cloaked: false, w: 800, h: 600 }), true);
t("no title", listable({ visible: true, title: " ", toolWindow: false, cloaked: false, w: 800, h: 600 }), false);
t("cloaked (other desktop / UWP ghost)", listable({ visible: true, title: "Settings", toolWindow: false, cloaked: true, w: 800, h: 600 }), false);
t("tool window", listable({ visible: true, title: "x", toolWindow: true, cloaked: false, w: 800, h: 600 }), false);
t("exe name", exeName("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), "chrome");
console.log(`${ok}/${n} window tests passed`);
if (ok !== n) process.exit(1);
