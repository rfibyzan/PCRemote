import assert from "node:assert/strict";
import { AUTH_TIMEOUT_MS, backoffDelay, openTimeoutFor, shouldRediscover } from "./reconnectmath.js";

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
console.log(`reconnectmath: ${n} tests ok`);
