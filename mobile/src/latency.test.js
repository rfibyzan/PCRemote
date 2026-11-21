// node src/latency.test.js
import { latencyLevel, rttFromPong, smoothRtt } from "./latency.js";
let n = 0, ok = 0;
function t(name, cond, info) { n++; if (cond) ok++; else console.log("FAIL", name, JSON.stringify(info)); }

let q = [1000, 3000];
t("echoed c wins over the queue", rttFromPong(q, { c: 3000 }, 3040) === 40, q);
t("queue still consumed", q.length === 1 && q[0] === 3000, q);
q = [1000, 3000];
t("old agent: oldest ping in the queue", rttFromPong(q, { t: "pong" }, 1050) === 50, q);
t("then the next one", rttFromPong(q, {}, 3020) === 20, q);
t("no ping waiting = no sample", rttFromPong([], {}, 5000) === null);
t("stale ping ignored", rttFromPong([0], {}, 40000) === null);
t("clock going backwards ignored", rttFromPong([], { c: 5000 }, 4000) === null);

t("first sample taken as is", smoothRtt(null, 42) === 42);
t("null sample keeps value", smoothRtt(40, null) === 40);
t("spike shows quickly", smoothRtt(40, 240) === 140, smoothRtt(40, 240));
t("drop eases down", smoothRtt(140, 40) === 115, smoothRtt(140, 40));

t("levels", latencyLevel(30) === "good" && latencyLevel(120) === "ok" && latencyLevel(300) === "slow" && latencyLevel(null) === null);
console.log(`${ok}/${n} latency tests passed`);
if (ok !== n) process.exit(1);
