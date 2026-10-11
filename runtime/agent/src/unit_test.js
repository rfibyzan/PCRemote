import { existsSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_ALPHABET, encryptJson, decryptJson, generateCode, keyFromCode, normalizeCode, NTFY_HOSTS, roomId } from "./crypto.js";
import { PORT } from "./fixed.js";
import { displayCode, loadLock, revokeLock } from "./lock.js";
import { comboPlan, describeKey, inputStructSize, monitorPoint, screenSize, stickyComboPlan, toVirtualAbs } from "./input.js";
import { pcKeysFromMobileKey, sameKeySet } from "./keypress.js";
import { tunnelBackoffMs, wokeFromSleep } from "./keepalive.js";
import { lanAddresses } from "./lan.js";
import { QUALITY, applyCrop, applyTune, encodeProfile, frameFingerprint, resolveDestWidth } from "./monitors.js";
import { assertCredits, CREDIT_DC, CREDIT_NAME, CREDIT_YT, creditByline, creditsIntact } from "./credits.js";
import { CAM_QUALITY, captureIds, parseDshowList, rankCameras } from "./webcam.js";
import { clamp, cursorOnRect, expandNorm, imageRect, mapPageToNorm, placeCrop, regionStillUsable, visibleNorm } from "./viewmap.js";

const results = [];

function pass(name, extra = "") {
  results.push({ name, ok: true, extra });
  console.log(`PASS  ${name}${extra ? `  (${extra})` : ""}`);
}

function fail(name, err) {
  results.push({ name, ok: false, extra: String(err) });
  console.log(`FAIL  ${name}  ${err}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function almost(a, b, eps = 0.02) {
  return Math.abs(a - b) <= eps;
}

function parseBinaryFrame(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 16 || raw[0] !== 0x50 || raw[1] !== 0x52) return null;
  const cropW = raw[14] / 255;
  const cropH = raw[15] / 255;
  return {
    t: "frame",
    mon: raw[2] === 1 ? "all" : raw[2] === 2 ? "cam" : raw[3],
    w: raw.readUInt16LE(4),
    h: raw.readUInt16LE(6),
    cx: raw.readUInt16LE(8) / 10000,
    cy: raw.readUInt16LE(10) / 10000,
    crop: cropW > 0 && cropH > 0 ? { x: raw[12] / 255, y: raw[13] / 255, w: cropW, h: cropH } : { x: 0, y: 0, w: 1, h: 1 },
  };
}

function testMapping() {
  assert(clamp(1.4) === 1 && clamp(-2) === 0 && clamp(0.4) === 0.4, "clamp");
  pass("clamp");

  const view = { w: 400, h: 200 };
  const img = { w: 2560, h: 1440 };
  const r0 = imageRect(view.w, view.h, img.w, img.h, 0, 0, 1);
  assert(almost(r0.left + r0.width / 2, view.w / 2, 1), "unzoomed image is centered x");
  assert(almost(r0.top + r0.height / 2, view.h / 2, 1), "unzoomed image is centered y");
  pass("unzoomed image centered", `${Math.round(r0.width)}x${Math.round(r0.height)}`);

  const mid = mapPageToNorm(200, 100, 0, 0, view.w, view.h, img.w, img.h, 0, 0, 1);
  assert(almost(mid.x, 0.5) && almost(mid.y, 0.5), `center map got ${mid.x},${mid.y}`);
  pass("tap center maps to 0.5,0.5");

  const z = 2.5;
  const rZ = imageRect(view.w, view.h, img.w, img.h, 0, 0, z);
  const throughZoom = mapPageToNorm(200, 100, 0, 0, view.w, view.h, img.w, img.h, 0, 0, z);
  assert(almost(throughZoom.x, 0.5, 0.03) && almost(throughZoom.y, 0.5, 0.03), "zoom keeps center");
  pass("zoom keeps visual center");

  const pan = { x: 40, y: -20 };
  const rPan = imageRect(view.w, view.h, img.w, img.h, pan.x, pan.y, z);
  const mapped = mapPageToNorm(rPan.left + rPan.width * 0.25, rPan.top + rPan.height * 0.75, 0, 0, view.w, view.h, img.w, img.h, pan.x, pan.y, z);
  assert(almost(mapped.x, 0.25, 0.02) && almost(mapped.y, 0.75, 0.02), `pan/zoom map ${mapped.x},${mapped.y}`);
  pass("pan/zoom tap hits the pixel you see");

  const cur = cursorOnRect(rPan, 0.25, 0.75);
  assert(almost(cur.left, rPan.left + rPan.width * 0.25, 1), "cursor x matches mapped point");
  pass("cursor overlay matches mapped tap");

  const box = { w: 400, h: 400 };
  const wide = { w: 1600, h: 900 };
  const letter = imageRect(box.w, box.h, wide.w, wide.h, 0, 0, 1);
  assert(letter.top > 40, "widescreen is letterboxed in a square view");
  const topTap = mapPageToNorm(200, letter.top + 2, 0, 0, box.w, box.h, wide.w, wide.h, 0, 0, 1);
  assert(topTap.y < 0.04, `image-top tap should be ~0, got ${topTap.y}`);
  const wrongIfUsingFullView = (letter.top + 2) / box.h;
  assert(wrongIfUsingFullView > 0.1, "sanity: full-view Y would be too low");
  pass("letterbox tap is not shifted down");

  const desktop = imageRect(400, 200, 2560, 1440, 0, 0, 2);
  const vis = visibleNorm(400, 200, 2560, 1440, 0, 0, 2);
  const patch = placeCrop(desktop, vis);
  const shifted = imageRect(400, 200, 2560, 1440, 48, -20, 2);
  const moved = placeCrop(shifted, vis);
  assert(almost(moved.left, patch.left + 48, 1) && almost(moved.top, patch.top - 20, 1), "crop patch follows pan");
  pass("look pan moves the current picture immediately");

  const tight = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
  const padded = expandNorm(tight, 1);
  assert(padded.w > tight.w && padded.h > tight.h && padded.w <= 1, "look crop is padded");
  pass("look encodes extra desktop around the view");

  // Panning must reuse the region we already hold, or Look mode shakes.
  const held = expandNorm({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0.7);
  assert(regionStillUsable(held, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), "held region serves the view it was made for");
  assert(regionStillUsable(held, { x: 0.42, y: 0.41, w: 0.2, h: 0.2 }), "a small pan reuses the held region");
  assert(!regionStillUsable(held, { x: 0.75, y: 0.4, w: 0.2, h: 0.2 }), "panning past the edge asks for a new region");
  assert(!regionStillUsable(held, { x: 0.45, y: 0.45, w: 0.05, h: 0.05 }), "zooming further in asks for real pixels");
  assert(!regionStillUsable(null, tight), "with nothing held we must ask");
  let churn = 0;
  let hold = null;
  for (let i = 0; i < 40; i++) {
    const view = { x: 0.3 + i * 0.004, y: 0.4, w: 0.2, h: 0.2 };
    if (!regionStillUsable(hold, view)) {
      hold = expandNorm(view, 0.7);
      churn++;
    }
  }
  assert(churn <= 4, `a slow 40-step pan should re-crop a handful of times, got ${churn}`);
  pass("panning holds its crop instead of re-cropping every frame");
}

function testKeys() {
  assert(inputStructSize() === 40, `INPUT size ${inputStructSize()} != 40`);
  const inputSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "input.js"), "utf8");
  assert(!/keybd_event\s*\(/.test(inputSrc), "keys use SendInput only — keybd_event double-fires");
  pass("SendInput struct is 40 bytes on x64");

  const win = describeKey("win");
  assert(win && win.vk === 0x5b, "win vk");
  assert(win.extended, "win is extended");
  assert(win.flagsDown & 0x0008, "win uses scancode");
  assert(win.flagsDown & 0x0001, "win uses extended flag");
  assert(win.flagsUp & 0x0002, "win up flag");
  pass("Win key uses scancode + extended");

  const start = describeKey("start");
  assert(start && start.vk === 0x5b, "start alias is win");
  pass("Start alias is Win");

  const alt = describeKey("alt");
  const tab = describeKey("tab");
  assert(alt.vk === 0x12 && tab.vk === 0x09, "alt/tab vks");
  assert(!(alt.flagsDown & 0x0001), "left alt is not extended");
  pass("Alt and Tab descriptors");

  const plan = comboPlan(["alt", "tab"]);
  assert(plan.length === 2 && plan[0].key === "alt" && plan[1].key === "tab", "alt+tab order");
  pass("Alt+Tab combo order is Alt then Tab");

  const sticky = stickyComboPlan(["alt", "tab"]);
  assert(sticky.mods.length === 1 && sticky.mods[0] === "alt" && sticky.tap === "tab", "sticky alt+tab");
  pass("Alt+Tab toggle holds Alt and taps Tab");

  const winTab = comboPlan(["win", "tab"]);
  assert(winTab.length === 2 && winTab[0].extended && winTab[0].vk === 0x5b, "win+tab");
  pass("Win+Tab combo uses extended Win");

  const arrows = ["left", "up", "right", "down", "home", "end", "pageup", "pagedown"];
  for (const name of arrows) {
    const info = describeKey(name);
    assert(info && info.extended, `${name} should be extended`);
  }
  pass("arrow/nav keys are extended");

  assert(describeKey("ctrl") && describeKey("shift") && describeKey("esc") && describeKey("enter"), "common keys");
  assert(describeKey("w") && describeKey("a") && describeKey("s") && describeKey("d"), "wasd");
  assert(describeKey("up") && describeKey("left") && describeKey("space"), "arrows/space");
  pass("WASD, arrows, and Space resolve");
}

function testMobileKeyHold() {
  assert(pcKeysFromMobileKey("a").keys.join("+") === "a", "letter a");
  assert(pcKeysFromMobileKey("A").keys.join("+") === "shift+a", "shift letter");
  assert(pcKeysFromMobileKey(" ").keys[0] === "space", "space");
  assert(pcKeysFromMobileKey("Enter").keys[0] === "enter", "enter");
  assert(pcKeysFromMobileKey("Backspace").keys[0] === "backspace", "backspace");
  assert(pcKeysFromMobileKey("!").keys.join("+") === "shift+1", "bang");
  assert(pcKeysFromMobileKey("-").keys[0] === "-", "minus");
  assert(describeKey("-") && describeKey("-").vk === 0xbd, "minus vk");
  assert(sameKeySet(["shift", "a"], ["shift", "a"]) && !sameKeySet(["a"], ["shift", "a"]), "same key set");
  pass("mobile key hold maps like a PC keyboard");
}

function testPointerMath() {
  const size = screenSize();
  assert(size.vw > 100 && size.vh > 100, "virtual desktop size");
  pass("virtual desktop", `${size.vw}x${size.vh} origin=${size.vx},${size.vy}`);

  const abs = toVirtualAbs(size.vx, size.vy);
  assert(abs.dx === 0 && abs.dy === 0, `top-left abs ${abs.dx},${abs.dy}`);
  const absMax = toVirtualAbs(size.vx + size.vw - 1, size.vy + size.vh - 1);
  assert(absMax.dx >= 65500 && absMax.dy >= 65500, `bottom-right ${absMax.dx},${absMax.dy}`);
  pass("absolute mouse covers the whole virtual desktop");

  const mon = { left: 100, top: 50, w: 200, h: 100 };
  const mid = monitorPoint(mon, 0.5, 0.5);
  assert(mid.x === 100 + Math.round(0.5 * 199) && mid.y === 50 + Math.round(0.5 * 99), "monitor point");
  pass("monitor-local tap maps to desktop pixels");
}

function testProtocolBits() {
  assert(PORT === 18765, "default port");
  assert(NTFY_HOSTS.length >= 2 && NTFY_HOSTS.includes("https://ntfy.sh"), "more than one announce board");
  pass("default listen port");

  const header = Buffer.alloc(16);
  header[0] = 0x50;
  header[1] = 0x52;
  header[2] = 0;
  header[3] = 1;
  header.writeUInt16LE(2560, 4);
  header.writeUInt16LE(1440, 6);
  header.writeUInt16LE(5000, 8);
  header.writeUInt16LE(2500, 10);
  header[12] = 64;
  header[13] = 32;
  header[14] = 128;
  header[15] = 96;
  const frame = parseBinaryFrame(header);
  assert(frame && frame.mon === 1 && frame.w === 2560 && frame.h === 1440, "binary header");
  assert(almost(frame.cx, 0.5) && almost(frame.cy, 0.25), "cursor in header");
  assert(almost(frame.crop.x, 64 / 255, 0.01) && almost(frame.crop.w, 128 / 255, 0.01), "crop in header");
  pass("binary frame header parse");

  // Presets are the user's call, so assert the invariants that must hold however
  // they are tuned rather than pinning the exact numbers.
  for (const step of [
    ["lite", "low"],
    ["low", "high"],
  ]) {
    const [cheap, rich] = step;
    assert(QUALITY[cheap].quality < QUALITY[rich].quality, `${cheap} compresses harder than ${rich}`);
    assert(QUALITY[cheap].fps <= QUALITY[rich].fps, `${cheap} sends no more frames than ${rich}`);
    assert(QUALITY[cheap].width < QUALITY[rich].width, `${cheap} resolution ceiling is below ${rich}`);
  }
  const readZoom = encodeProfile("high", false, true);
  assert(readZoom.width >= 1920, "zoomed read must not cap resolution below a phone screen");
  assert(readZoom.width > QUALITY.high.width, "resolution budget is spent on the zoomed crop, not the overview");
  const remoteLite = encodeProfile("lite", true);
  const lite = encodeProfile("lite");
  assert(lite.width < QUALITY.low.width && lite.fps <= QUALITY.low.fps && lite.quality < QUALITY.low.quality, "lite is below live");
  // A metered link must never cost more than the same preset on wifi.
  for (const key of ["lite", "low", "high"]) {
    const near = encodeProfile(key, false);
    const far = encodeProfile(key, true);
    assert(far.fps <= near.fps, `remote ${key} sends no more frames than local`);
    assert(far.width <= near.width, `remote ${key} resolution ceiling is no higher than local`);
    assert(far.quality <= near.quality, `remote ${key} compresses at least as hard as local`);
  }
  assert(remoteLite.fps <= 6, "remote lite sips data");
  const abs = encodeProfile("low", false, false, { width: 1280, jpeg: 80, fps: 20 });
  assert(abs.quality === 80 && abs.fps === 20, "phone can set jpeg quality and fps directly");
  assert(abs.width === QUALITY.low.width, "phone cannot raise the resolution ceiling above the preset");
  const tighter = encodeProfile("low", false, false, { width: 480 });
  assert(tighter.width === 480, "phone can tighten the resolution ceiling to save data");
  const mappedSuper = encodeProfile("super");
  assert(mappedSuper.quality === QUALITY.high.quality && mappedSuper.fps === QUALITY.high.fps, "old super chip maps to high");
  const nudged = applyTune(QUALITY.low, { qStep: 2, fpsStep: 3 });
  assert(nudged.quality === QUALITY.low.quality + 16, "quality step is +8 jpeg");
  assert(nudged.fps === QUALITY.low.fps + 6, "fps step is +2");
  assert(nudged.width === QUALITY.low.width, "Q arrows do not change capture width");
  const floor = applyTune(QUALITY.lite, { qStep: -20, fpsStep: -20 });
  assert(floor.quality >= 18 && floor.fps >= 1 && floor.width === QUALITY.lite.width, "tune clamps jpeg, keeps preset width");
  assert(floor.fps === 1, "fps can be dialled down to 1 for the lightest possible stream");
  // The whole point of the resolution rule: zooming must buy real pixels.
  const phonePx = 1216;
  const deskW = 2560;
  assert(resolveDestWidth(1920, phonePx, deskW) === phonePx, "high at 1x is capped by the phone's real pixels");
  assert(resolveDestWidth(800, phonePx, deskW) === 800, "mid at 1x stays inside its data budget");
  const crop3x = Math.round(deskW / 3);
  assert(resolveDestWidth(1920, phonePx, crop3x) === crop3x, "high at 3x zoom encodes the crop 1:1");
  assert(resolveDestWidth(1920, phonePx, 400) === 400, "never upscales past the region's own size");
  assert(resolveDestWidth(1920, 0, deskW) === 1920, "older app without viewPx still gets the preset cap");
  const oneToOne = resolveDestWidth(1920, phonePx, crop3x) / crop3x;
  assert(oneToOne >= 1, `zoomed crop must not be shrunk, got ${oneToOne}`);
  pass("zoom buys real resolution instead of magnified blur");

  const zoomed = encodeProfile("low", false, true);
  const flat = encodeProfile("low", false, false);
  assert(zoomed.width >= flat.width, "zooming raises the resolution ceiling for the crop");
  assert(zoomed.quality <= 56, "zoomed live still compresses");
  const box = { left: 0, top: 0, w: 2560, h: 1440 };
  const mid = applyCrop(box, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert(mid.w === 1280 && mid.h === 720, "crop is half the desktop");
  const vis = visibleNorm(400, 200, 2560, 1440, 0, 0, 2);
  assert(vis.w < 0.7 && vis.h < 0.7, "zoom 2x shows less than the full screen");
  const a = Buffer.from("hello-screen");
  const b = Buffer.from("hello-screen");
  const c = Buffer.from("other-screen");
  assert(frameFingerprint(a) === frameFingerprint(b) && frameFingerprint(a) !== frameFingerprint(c), "idle fingerprint");
  assert(describeKey("f4") && describeKey("f4").vk === 0x73, "f4");
  const altF4 = stickyComboPlan(["alt", "f4"]);
  assert(altF4.mods[0] === "alt" && altF4.tap === "f4", "alt+f4 plan");
  pass("Low/Mid/High quality presets plus arrows");
}

function testTrayAndShortcuts() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const startBat = readFileSync(path.join(root, "start.bat"), "utf8");
  assert(startBat.includes("PCREMOTE_TRAY=1"), "start.bat enables tray");
  assert(startBat.includes("goto retry"), "start.bat restarts after a crash");
  const tray = readFileSync(path.join(root, "tray.ps1"), "utf8");
  assert(tray.includes("Close PC Remote"), "tray has close item");
  assert(tray.includes("YouTube · Asphalt Cake"), "tray links the channel");
  assert(tray.includes("PC Remote · Asphalt Cake"), "tray tooltip credits the author");
  const installPath = path.join(root, "install-startup.ps1");
  const launcherPath = path.join(root, "scripts", "PCRemoteLauncher.cs");
  const manifestPath = path.join(root, "scripts", "PCRemote.exe.manifest");
  if (!existsSync(installPath) || !existsSync(launcherPath) || !existsSync(manifestPath)) {
    // Shipped-folder layout without installer/launcher sources: the tray
    // assertions above already ran, the rest is skipped, not failed.
    pass("tray close menu (installer sources absent — skipped)");
    return;
  }
  const install = readFileSync(installPath, "utf8");
  assert(install.includes("Start PC Remote"), "installer writes a desktop shortcut");
  const launcher = readFileSync(launcherPath, "utf8");
  assert(launcher.includes("NotifyIcon"), "launcher owns the tray icon");
  assert(launcher.includes("YouTube · Asphalt Cake"), "launcher menu credits the channel");
  assert(launcher.includes("PCRemote.Launcher"), "launcher is single-instance");
  assert(launcher.includes("Unblock-File"), "launcher unblocks downloaded files");
  assert(launcher.includes("StopOtherInstances"), "launcher replaces an old instance");
  const manifest = readFileSync(manifestPath, "utf8");
  assert(manifest.includes("requireAdministrator"), "exe requests elevation");
  pass("tray close menu and desktop shortcut installer");
}

function testWebcamParse() {
  const ffmpeg9 = `
[in#0 @ 123] "Creative Live! Cam 4K" (video)
[in#0 @ 123]   Alternative name "@device_pnp_\\\\?\\usb#vid_041e"
[in#0 @ 123] "Microphone (Elgato Wave:3)" (audio)
`;
  const cams = parseDshowList(ffmpeg9);
  assert(cams.length === 1 && cams[0].name === "Creative Live! Cam 4K", `parsed ${JSON.stringify(cams)}`);
  pass("ffmpeg 9 dshow video list");

  const mixed = rankCameras([
    { name: "IR Camera", alt: "" },
    { name: "USB2.0 HD UVC WebCam", alt: "@device_pnp_usb" },
    { name: "OBS Virtual Camera", alt: "" },
  ]);
  assert(mixed[0].name.includes("UVC"), `preferred ${mixed[0].name}`);
  assert(captureIds(mixed[0])[0].startsWith("@device"), "alt id first");
  pass("webcam ranking prefers a real camera");

  const old = `DirectShow video devices\n "HD Webcam"\n   Alternative name "@device_pnp_abc"\nDirectShow audio devices\n "Mic"`;
  const oldCams = parseDshowList(old);
  assert(oldCams.length === 1 && oldCams[0].name === "HD Webcam", "old dshow list");
  pass("legacy dshow video list");

  const header = Buffer.alloc(16);
  header[0] = 0x50;
  header[1] = 0x52;
  header[2] = 2;
  header.writeUInt16LE(960, 4);
  header.writeUInt16LE(540, 6);
  const camFrame = parseBinaryFrame(header);
  assert(camFrame && camFrame.mon === "cam" && camFrame.w === 960, "cam frame header");
  assert(CAM_QUALITY.lite.width < CAM_QUALITY.low.width, "cam lite is smaller than live");
  pass("webcam binary frame kind");
}

function testKeepalive() {
  assert(!wokeFromSleep(1000, 30_000, 90_000), "30s is not sleep");
  assert(wokeFromSleep(1000, 200_000, 90_000), "gap after sleep");
  assert(tunnelBackoffMs(2000) === 4000, "backoff doubles");
  assert(tunnelBackoffMs(50_000) === 60_000, "backoff caps");
  pass("sleep gap and tunnel backoff");
}

function testLanAddresses() {
  const nets = {
    eth: [
      { family: 4, internal: false, address: "10.1.2.3" },
      { family: "IPv4", internal: false, address: "192.168.1.9" },
      { family: "IPv4", internal: false, address: "169.254.8.8" },
      { family: "IPv6", internal: false, address: "fe80::1" },
      { family: "IPv4", internal: true, address: "127.0.0.1" },
    ],
  };
  const found = lanAddresses(nets);
  assert(found.join(",") === "10.1.2.3,192.168.1.9", `lan ${found.join(",")}`);
  pass("LAN list accepts Node 18 numeric family and skips link-local");
}

function testLock() {
  const tmp = path.join(os.tmpdir(), `pcremote-lock-test-${Date.now()}.json`);
  process.env.PCREMOTE_LOCK = tmp;
  try {
    const a = loadLock();
    assert(a.code.length === 8, `code length ${a.code.length}`);
    for (const ch of a.code) assert(CODE_ALPHABET.includes(ch), `alphabet ${ch}`);
    assert(displayCode(a.code).includes(" "), "display has a gap");
    const b = loadLock();
    assert(a.code === b.code, "lock file does not rotate on restart");
    const c = revokeLock();
    assert(c.code !== a.code && c.code.length === 8, "revoke mints a new code");
    const d = loadLock();
  assert(d.code === c.code, "revoked code is what restarts use");
  const agentSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
  assert(agentSrc.includes("state.room}|${body.lan"), "announce sig includes lock room so revoke republishes");
  assert(agentSrc.includes("kickAllClients"), "revoke kicks old phone sessions");
  assert(agentSrc.includes("publishAnnounce(true)"), "revoke forces a fresh announce");
  pass("lock survives restart until revoke");
  } finally {
    delete process.env.PCREMOTE_LOCK;
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }

  const one = generateCode();
  const two = generateCode();
  assert(one.length === 8 && two.length === 8, "generated codes");
  assert(roomId(one) !== roomId(two), "rooms are per lock");
  assert(normalizeCode("ab cd-ef") === "ABCDEF", "normalize");
  const key = keyFromCode("TESTCODE");
  const boxed = encryptJson({ tunnel: "wss://example.trycloudflare.com", lan: ["10.0.0.5:18765"], port: 18765 }, key);
  const opened = decryptJson(boxed, key);
  assert(opened.tunnel.includes("trycloudflare") && opened.port === 18765, "announce roundtrip");
  pass("lock rooms and encrypted announce");
}

function testCredits() {
  assert(creditsIntact(), "credit seal fingerprint matches");
  assertCredits("unit");
  assert(CREDIT_NAME === "Asphalt Cake", "author name");
  assert(CREDIT_YT === "https://www.youtube.com/@AsphaltCake", "youtube url");
  assert(CREDIT_DC === "discord.gg/vKVBbyfHTD", "discord invite");
  assert(creditByline() === "by Asphalt Cake", "byline");
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "credits.js"), "utf8");
  assert(!src.includes("Asphalt Cake"), "author name is not plaintext in credits.js");
  assert(!src.includes("discord.gg/vKVBbyfHTD"), "discord invite is not plaintext in credits.js");
  assert(!src.includes("@AsphaltCake"), "channel handle is not plaintext in credits.js");
  pass("credit seal and obfuscation");
}

try {
  testMapping();
  testKeys();
  testMobileKeyHold();
  testPointerMath();
  testProtocolBits();
  testCredits();
  testTrayAndShortcuts();
  testWebcamParse();
  testKeepalive();
  testLanAddresses();
  testLock();
} catch (err) {
  fail("unit suite", err);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} unit tests passed`);
if (failed.length) process.exit(1);
