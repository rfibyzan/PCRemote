// node src/apps_test.js (pure)
import { appsForPhone, cleanApps } from "./appsmath.js";
let n = 0;
let ok = 0;
const t = (name, got, want) => {
  n += 1;
  if (JSON.stringify(got) === JSON.stringify(want)) ok += 1;
  else console.log("FAIL", name, JSON.stringify(got), "!=", JSON.stringify(want));
};
const rows = [
  { id: "Chrome", name: "Google Chrome", target: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", icon: "x" },
  { id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: "Calculator", target: "", icon: "y" },
  { id: "u1", name: "Uninstall Foo", target: "C:\\Foo\\unins000.exe" },
  { id: "r1", name: "Foo Website", target: "https://foo.com" },
  { id: "r2", name: "Manual", target: "C:\\Foo\\manual.pdf" },
  { id: "Chrome2", name: "google chrome", target: "" },
  { id: "", name: "Blank" },
];
const list = cleanApps(rows);
t("junk + dupes dropped, A-Z", list.map((a) => a.name), ["Calculator", "Google Chrome"]);
t("exe can run as admin", list[1].admin, true);
t("store app no admin", list[0].admin, false);
t("single object input", cleanApps({ id: "a", name: "A" }).length, 1);
t("null input", cleanApps(null), []);
t("phone payload hides target", Object.keys(appsForPhone(list)[1]), ["id", "name", "icon", "admin"]);
console.log(`apps ${ok}/${n}`);
if (ok !== n) process.exit(1);
