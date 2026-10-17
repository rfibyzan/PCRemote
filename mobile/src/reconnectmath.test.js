import assert from "node:assert/strict";
import { AUTH_TIMEOUT_MS, backoffDelay, lanCandidates, openTimeoutFor, shouldRediscover } from "./reconnectmath.js";

let n = 0;
const t = (name, fn) => {
  fn();
  n += 1;
};
t("open timeout shorter for LAN than tunnel", () => {
  assert.equal(openTimeoutFor("wifi"), 4000);
  assert.equal(openTimeoutFor("usb"), 4000);
  assert.equal(openTimeoutFor("remote"), 10000);
  assert.ok(openTimeoutFor("wifi") < AUTH_TIMEOUT_MS);
});
t("backoff grows and caps", () => {
  assert.equal(backoffDelay(1), 1500);
  assert.equal(backoffDelay(2), 2250);
  assert.equal(backoffDelay(50), 15000);
  assert.equal(backoffDelay(0), 1500);
});
t("dead address rediscovers at once", () => {
  assert.equal(shouldRediscover({ tries: 1, reason: "unreachable", hasCode: true }), true);
  assert.equal(shouldRediscover({ tries: 1, reason: "open-failed", hasCode: true }), true);
});
t("other drops rediscover every 3rd try", () => {
  assert.equal(shouldRediscover({ tries: 1, reason: "code=1006", hasCode: true }), false);
  assert.equal(shouldRediscover({ tries: 2, reason: "auth-timeout", hasCode: true }), false);
  assert.equal(shouldRediscover({ tries: 3, reason: "auth-timeout", hasCode: true }), true);
});
t("no code never rediscovers", () => {
  assert.equal(shouldRediscover({ tries: 3, reason: "unreachable", hasCode: false }), false);
});
t("lan candidates from hello + saved private hosts", () => {
  const c = lanCandidates({
    hello: { lan: ["192.168.100.7", "8.8.8.8", "10.0.0.5"], port: 18766 },
    lastHosts: ["https://abc.trycloudflare.com", "http://192.168.100.7:18766", "http://172.20.1.2:18765"],
    defaultPort: 18765,
  });
  assert.deepEqual(c, ["http://192.168.100.7:18766", "http://10.0.0.5:18766", "http://172.20.1.2:18765"]);
});
t("old agent without lan in hello uses saved hosts only", () => {
  assert.deepEqual(lanCandidates({ hello: { name: "PC" }, lastHosts: ["http://192.168.1.2:18765"], defaultPort: 18765 }), ["http://192.168.1.2:18765"]);
  assert.deepEqual(lanCandidates({ hello: null, lastHosts: [], defaultPort: 18765 }), []);
});
console.log(`reconnectmath: ${n} tests ok`);
