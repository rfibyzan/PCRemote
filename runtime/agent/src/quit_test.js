// node src/quit_test.js — POST /api/quit guard + shutdown order (no Windows deps).
import assert from "node:assert/strict";
import { QUIT_PATH, quitAllowed, scheduleQuit } from "./quit.js";

const req = (method, ip, headers = {}) => ({ method, socket: { remoteAddress: ip }, headers });
const local = { host: "127.0.0.1:18765", "x-pcremote": "1" };

assert.equal(QUIT_PATH, "/api/quit");
assert.ok(quitAllowed(req("POST", "127.0.0.1", local)), "launcher on this PC may quit");
assert.ok(quitAllowed(req("POST", "::1", { host: "localhost:18766", "x-pcremote": "1" })));
assert.ok(!quitAllowed(req("GET", "127.0.0.1", local)), "GET refused");
assert.ok(!quitAllowed(req("POST", "127.0.0.1", { host: "127.0.0.1:18765" })), "no X-PCRemote header (CSRF) refused");
assert.ok(!quitAllowed(req("POST", "192.168.1.9", { host: "192.168.1.4:18765", "x-pcremote": "1" })), "LAN refused");
assert.ok(!quitAllowed(req("POST", "127.0.0.1", { ...local, host: "x.trycloudflare.com", "cf-ray": "1" })), "tunnel refused");
assert.ok(!quitAllowed(req("POST", "127.0.0.1", { ...local, host: "evil.example:18765" })), "DNS rebinding refused");
assert.ok(!quitAllowed(null));

const calls = [];
let delay = -1;
scheduleQuit({
  stop: [
    () => calls.push("tunnel"),
    () => {
      throw new Error("boom");
    },
    () => Promise.reject(new Error("async boom")),
    () => calls.push("cam"),
  ],
  exit: (code) => calls.push(`exit:${code}`),
  delayMs: 250,
  timer: (fn, ms) => {
    delay = ms;
    fn();
  },
});
assert.deepEqual(calls, ["tunnel", "cam", "exit:0"], "hooks run, errors ignored, then exit 0");
assert.equal(delay, 250);

console.log("quit_test: ok");
