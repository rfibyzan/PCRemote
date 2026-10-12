// node src/devices_test.js — device registry + request guards (no Windows deps).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceStore, isLocalRequest, linkOf, sanitizeDevice } from "./devices.js";

const file = join(mkdtempSync(join(tmpdir(), "pcr-")), "devices.json");
const a = createDeviceStore(file);
const dev = sanitizeDevice({ id: "abc<script>", name: "Xiaomi\n 13", os: "Android 14" }, "1.2.3.4");
assert.equal(dev.id, "abcscript");
assert.equal(dev.name, "Xiaomi 13");
assert.equal(sanitizeDevice(null, "10.0.0.5").id, "ip-10.0.0.5");
a.seen(dev, { ip: "192.168.1.9", link: "wifi", now: 1 });
a.seen(dev, { ip: "192.168.1.9", link: "wifi", now: 2 });
a.setBlocked(dev.id, true);
const b = createDeviceStore(file);
assert.equal(b.get(dev.id).count, 2, "persists across restart");
assert.ok(b.isBlocked(dev.id));
b.setBlocked(dev.id, false);
assert.ok(!b.isBlocked(dev.id));
b.forget(dev.id);
assert.equal(b.list().length, 0);

const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
assert.ok(isLocalRequest(req("127.0.0.1", { host: "127.0.0.1:18765" })));
assert.ok(isLocalRequest(req("::ffff:127.0.0.1", { host: "localhost:18765" })));
assert.ok(!isLocalRequest(req("192.168.1.9", { host: "192.168.1.4:18765" })), "LAN refused");
assert.ok(!isLocalRequest(req("127.0.0.1", { host: "x.trycloudflare.com", "cf-ray": "1" })), "tunnel refused");
assert.ok(!isLocalRequest(req("127.0.0.1", { host: "evil.example:18765" })), "DNS rebinding refused");
assert.equal(linkOf(req("127.0.0.1", { "cf-connecting-ip": "36.1.2.3" })).link, "internet");
assert.equal(linkOf(req("192.168.1.9")).link, "wifi");
assert.equal(linkOf(req("::1")).link, "usb");
console.log("devices: ok");
