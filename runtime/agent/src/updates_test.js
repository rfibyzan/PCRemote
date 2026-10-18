// node src/updates_test.js — update check + one-click update helpers (no Windows deps).
import assert from "node:assert/strict";
import path from "node:path";
import { checkForUpdate, compareVersions, newerRelease, pickUpdateAsset } from "./updates.js";
import { findStagedRoot, installRoot, progressText, relaunchMode } from "./updater.js";

assert.equal(compareVersions("v1.3.0", "v1.2.0"), 1);
assert.equal(compareVersions("v1.3.0", "1.3.0"), 0);
assert.equal(compareVersions("v1.10.0", "v1.9.9"), 1);
assert.equal(compareVersions("v1.3", "v1.3.1"), -1);

const asset = (name) => ({ name, size: 1000, browser_download_url: `https://github.com/rfibyzan/PCRemote/releases/download/v1.4.0/${name}` });
const rel = (tag, names) => ({ tag_name: tag, html_url: `https://github.com/rfibyzan/PCRemote/releases/tag/${tag}`, assets: names.map(asset) });

// small update zip wins, full zip is the fallback, apk never
assert.equal(pickUpdateAsset(rel("v1.4.0", ["PCRemote-v1.4.0.apk", "PCRemote-v1.4.0-windows.zip", "PCRemote-v1.4.0-update.zip"])).name, "PCRemote-v1.4.0-update.zip");
const full = pickUpdateAsset(rel("v1.4.0", ["PCRemote-v1.4.0.apk", "PCRemote-v1.4.0-windows.zip"]));
assert.equal(full.name, "PCRemote-v1.4.0-windows.zip");
assert.equal(full.full, true);
assert.equal(pickUpdateAsset(rel("v1.4.0", ["PCRemote-v1.4.0.apk"])), null);
assert.equal(pickUpdateAsset({ assets: [{ name: "x-update.zip", browser_download_url: "http://insecure/x-update.zip" }] }), null, "https only");

const u = newerRelease("v1.3.0", rel("v1.4.0", ["PCRemote-v1.4.0-update.zip"]));
assert.equal(u.tag, "v1.4.0");
assert.equal(u.asset.name, "PCRemote-v1.4.0-update.zip");
assert.equal(newerRelease("v1.4.0", rel("v1.4.0", [])), null, "same version");
assert.equal(newerRelease("v1.5.0", rel("v1.4.0", [])), null, "older release");
assert.equal(newerRelease("", rel("v1.4.0", [])), null, "git checkout never updates");
assert.equal(newerRelease("v1.3.0", { ...rel("v1.4.0", []), prerelease: true }), null);

// network shapes
assert.deepEqual(await checkForUpdate(""), { ok: false, error: "dev" });
const okFetch = async () => ({ ok: true, json: async () => rel("v1.4.0", ["PCRemote-v1.4.0-update.zip"]) });
assert.equal((await checkForUpdate("v1.3.0", okFetch)).update.tag, "v1.4.0");
assert.equal((await checkForUpdate("v1.4.0", okFetch)).update, null);
assert.deepEqual(await checkForUpdate("v1.3.0", async () => ({ ok: false, status: 403 })), { ok: false, error: "GitHub 403" });
assert.equal((await checkForUpdate("v1.3.0", async () => { throw new Error("offline"); })).ok, false);

// unpacked zip: top PCRemote folder, or the files directly
const idx = (d) => path.join(d, "runtime", "agent", "src", "index.js");
const tree = new Set([idx(path.join("/t", "PCRemote"))]);
assert.equal(findStagedRoot("/t", (p) => tree.has(p), () => ["PCRemote"]), path.join("/t", "PCRemote"));
assert.equal(findStagedRoot("/t", (p) => p === idx("/t"), () => []), "/t");
assert.equal(findStagedRoot("/t", () => false, () => ["junk"]), null);

assert.equal(installRoot({ PCREMOTE_HOME: "/r" }, "/x/runtime/agent"), path.resolve("/r"));
assert.equal(installRoot({}, "/x/runtime/agent"), path.resolve("/x"));
assert.equal(relaunchMode({ PCREMOTE_LAUNCHER: "1" }), "exe");
assert.equal(relaunchMode({ PCREMOTE_SUPERVISED: "1" }), "bat");

assert.equal(progressText({ phase: "download", done: 5 * 1048576, total: 10 * 1048576 }), "Mengunduh 50% (5.0 / 10.0 MB)");
assert.match(progressText({ phase: "error", error: "x" }), /^Gagal: x/);
assert.equal(progressText(null), "");

console.log("updates_test: ok");
