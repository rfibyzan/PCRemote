import { findExistingAgent, loadLock } from "./lock.js";
import { cursorPos, setCursorPixel } from "./input.js";
import { listMonitors } from "./monitors.js";
import WebSocket from "ws";

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function request(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function parseIncoming(raw) {
  if (Buffer.isBuffer(raw) && raw.length >= 16 && raw[0] === 0x50 && raw[1] === 0x52) {
    return {
      t: "frame",
      mon: raw[2] === 1 ? "all" : raw[2] === 2 ? "cam" : raw[3],
      w: raw.readUInt16LE(4),
      h: raw.readUInt16LE(6),
      jpeg: "ok",
      bytes: raw.length - 16,
    };
  }
  return JSON.parse(String(raw));
}

function connect(token, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => reject(new Error("ws timeout")), 4000);
    const inbox = [];
    ws.on("open", () => ws.send(JSON.stringify({ t: "auth", token })));
    ws.on("message", (raw) => {
      const msg = parseIncoming(raw);
      inbox.push(msg);
      if (msg.t === "hello") {
        clearTimeout(timer);
        resolve({
          ws,
          inbox,
          send: (obj) => ws.send(JSON.stringify(obj)),
          hello: msg,
        });
      }
      if (msg.t === "error") reject(new Error(msg.m));
    });
    ws.on("error", reject);
  });
}

async function expect(session, type, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = session.inbox.find((m) => m.t === type);
    if (hit) return hit;
    await wait(40);
  }
  throw new Error(`did not receive ${type}`);
}

async function expectFrame(session, monId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = [...session.inbox]
      .reverse()
      .find((m) => m.t === "frame" && String(m.mon) === String(monId));
    if (hit) return hit;
    await wait(40);
  }
  throw new Error(`did not receive frame for ${monId}`);
}

const results = [];
function pass(name, extra = "") {
  results.push({ name, ok: true, extra });
  console.log(`PASS  ${name}${extra ? `  (${extra})` : ""}`);
}
function fail(name, err) {
  results.push({ name, ok: false, extra: String(err) });
  console.log(`FAIL  ${name}  ${err}`);
}

async function main() {
  const existing = await findExistingAgent();
  if (!existing) throw new Error("PC Remote agent is not running");
  const port = existing.port;
  const code = loadLock().code;
  const health = existing.health;
  if (!health.ok) throw new Error("health not ok");
  pass("health", `${health.name} internet=${Boolean(health.internet)}`);

  if (!Array.isArray(health.monitors) || health.monitors.length < 1) throw new Error("no monitors");
  pass("monitors listed", health.monitors.map((m) => `${m.name} ${m.w}x${m.h}`).join(", "));

  const session = await connect(code, port);
  pass("websocket auth", session.hello.name);
  if (!session.hello.monitors?.length) throw new Error("hello missing monitors");
  pass("hello monitors", String(session.hello.monitors.length));

  const primaryId = session.hello.monitors.find((m) => m.primary)?.id ?? 0;
  session.send({ t: "quality", q: "low" });
  session.send({ t: "screen", on: true });
  const frame = await expectFrame(session, primaryId, 6000);
  if (!frame.w || !frame.bytes) throw new Error("empty frame");
  pass("screen frame", `${frame.w}x${frame.h} jpeg=${frame.bytes}B`);

  for (const mon of session.hello.monitors) {
    session.send({ t: "monitor", id: mon.id });
    const next = await expectFrame(session, mon.id, 5000);
    pass(`switch monitor ${mon.id}`, `${mon.name} ${next.w}x${next.h}`);
  }

  session.send({ t: "monitor", id: "all" });
  const all = await expectFrame(session, "all", 6000);
  // "all" must span the whole virtual desktop (bounding box of every
  // monitor) — on a single-monitor PC that is just that monitor, so no
  // absolute minimum width may be assumed here.
  const mons = listMonitors();
  const virtualW = Math.max(...mons.map((m) => m.right)) - Math.min(...mons.map((m) => m.left));
  const virtualH = Math.max(...mons.map((m) => m.bottom)) - Math.min(...mons.map((m) => m.top));
  if (all.w !== virtualW || all.h !== virtualH) {
    throw new Error(`all-view ${all.w}x${all.h} != desktop ${virtualW}x${virtualH}`);
  }
  if (!all.bytes) throw new Error("all-view empty frame");
  pass("all monitors view", `${all.w}x${all.h}`);

  session.send({ t: "ping" });
  await expect(session, "pong", 2000);
  pass("heartbeat");

  session.inbox.length = 0;
  session.send({ t: "monitor", id: primaryId });
  await expectFrame(session, primaryId, 4000);

  const savedCursor = cursorPos();
  try {
    session.send({ t: "abs", x: 0.5, y: 0.5 });
    await wait(150);
    const primary = listMonitors().find((m) => m.primary) || listMonitors()[0];
    const here = cursorPos();
    const expectX = Math.round(primary.left + 0.5 * (primary.w - 1));
    const expectY = Math.round(primary.top + 0.5 * (primary.h - 1));
    if (Math.abs(here.x - expectX) > 90 || Math.abs(here.y - expectY) > 90) {
      throw new Error(`cursor ${here.x},${here.y} != ${expectX},${expectY}`);
    }
    pass("absolute cursor lands on monitor", `${here.x},${here.y}`);

    session.send({ t: "drag", phase: "start", x: 0.5, y: 0.5, btn: "left" });
    session.send({ t: "drag", phase: "move", x: 0.52, y: 0.51, btn: "left" });
    session.send({ t: "drag", phase: "end", x: 0.52, y: 0.51, btn: "left" });
    await wait(80);
    pass("left-drag press/move/release");

    session.send({ t: "key", key: "shift" });
    session.send({ t: "combo", keys: ["ctrl", "shift"] });
    await wait(40);
    pass("modifier key tap and combo");

    session.send({ t: "scroll", dy: 120, dx: 0 });
    pass("scroll command");
  } finally {
    setCursorPixel(savedCursor.x, savedCursor.y);
  }

  session.send({ t: "screen", on: false });
  session.ws.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error("SELFTEST ERROR", err);
  process.exit(1);
});
