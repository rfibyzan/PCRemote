import assert from "node:assert/strict";
import { RELEASES_PAGE, compareVersions, decideUpdate, pickApk } from "./updatemath.js";

let n = 0;
const t = (name, fn) => {
  fn();
  n += 1;
};
const rel = (tag, names = [`PCRemote-${tag}.apk`, `PCRemote-${tag}-windows.zip`]) => ({
  tag_name: tag,
  html_url: `https://github.com/rfibyzan/PCRemote/releases/tag/${tag}`,
  assets: names.map((name) => ({ name, browser_download_url: `https://github.com/rfibyzan/PCRemote/releases/download/${tag}/${name}` })),
});

t("versions", () => {
  assert.equal(compareVersions("v1.4.0", "1.3.0"), 1);
  assert.equal(compareVersions("1.3.0", "v1.3.0"), 0);
  assert.equal(compareVersions("v1.3.9", "v1.10.0"), -1);
});
t("apk link", () => {
  assert.match(pickApk(rel("v1.4.0")), /PCRemote-v1\.4\.0\.apk$/);
  assert.equal(pickApk(rel("v1.4.0", ["x.zip"])), null);
});
t("newer GitHub release -> its APK", () => {
  const u = decideUpdate({ appVersion: "1.3.0", release: rel("v1.4.0") });
  assert.equal(u.tag, "v1.4.0");
  assert.equal(u.source, "github");
  assert.match(u.url, /\.apk$/);
});
t("same or older -> nothing", () => {
  assert.equal(decideUpdate({ appVersion: "1.4.0", release: rel("v1.4.0") }), null);
  assert.equal(decideUpdate({ appVersion: "1.5.0", release: rel("v1.4.0") }), null);
  assert.equal(decideUpdate({ appVersion: "1.3.0", release: { ...rel("v1.4.0"), prerelease: true } }), null);
  assert.equal(decideUpdate({ appVersion: "", release: rel("v1.4.0") }), null);
});
t("release without apk -> release page", () => {
  assert.match(decideUpdate({ appVersion: "1.3.0", release: rel("v1.4.0", ["a.zip"]) }).url, /releases\/tag\/v1\.4\.0$/);
});
t("PC newer while GitHub unknown -> releases page", () => {
  const u = decideUpdate({ appVersion: "1.3.0", pcVersion: "v1.4.0" });
  assert.equal(u.source, "pc");
  assert.equal(u.url, RELEASES_PAGE);
  assert.equal(decideUpdate({ appVersion: "1.3.0", pcVersion: "" }), null, "git checkout PC");
  assert.equal(decideUpdate({ appVersion: "1.3.0", release: rel("v1.4.0"), pcVersion: "v1.4.0" }).source, "github");
});
t("dismissed tag stays hidden until a newer one", () => {
  assert.equal(decideUpdate({ appVersion: "1.3.0", release: rel("v1.4.0"), dismissed: "v1.4.0" }), null);
  assert.equal(decideUpdate({ appVersion: "1.3.0", release: rel("v1.5.0"), dismissed: "v1.4.0" }).tag, "v1.5.0");
});
console.log(`updatemath: ${n} ok`);
