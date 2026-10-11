/** Blue cursor-ring overlay (original-app marker).
 * Pure presentational + mapping math. Never touches ScreenView internals:
 * parents render <CursorDot> as a pointerEvents="none" sibling and feed it
 * from ScreenView onFrame (frame.cx/cy) + {t:"cur"} socket messages.
 * Position state is throttled (moves > ~0.4% only) so the ring never causes
 * per-frame re-render churn or any image flicker.
 */
import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { addListener } from "./connection";

const RING = 22;
const MOVE_EPS = 0.004;

/** Monitor-normalized cursor -> pixel offset inside a contain-fit viewer. */
export function cursorPixels(cx, cy, vw, vh, fw, fh, crop) {
  const fw2 = fw || vw;
  const fh2 = fh || vh;
  const scale = Math.min(vw / Math.max(1, fw2), vh / Math.max(1, fh2));
  const dispW = Math.max(1, fw2 * scale);
  const dispH = Math.max(1, fh2 * scale);
  const offX = (vw - dispW) / 2;
  const offY = (vh - dispH) / 2;
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  const nx = (cx - c.x) / Math.max(0.001, c.w);
  const ny = (cy - c.y) / Math.max(0.001, c.h);
  return {
    x: offX + nx * dispW,
    y: offY + ny * dispH,
    visible: nx >= -0.02 && nx <= 1.02 && ny >= -0.02 && ny <= 1.02,
  };
}

export function CursorDot({ x, y }) {
  if (x == null || y == null) return null;
  return <View pointerEvents="none" style={[styles.ring, { left: x - RING / 2, top: y - RING / 2 }]} />;
}

/** Client-side stream metering (no agent change): counts JPEG bytes seen by
 * the active viewer. feeds from useCursor.feed (only the registered screen
 * handler receives frames, so exactly the displayed stream is measured). */
const statWin = []; // {t, bytes} of the last ~2 s
let statTotal = 0;
let statDropped = 0;

export function trackFrameBytes(n) {
  if (!n) return;
  const now = Date.now();
  statTotal += n;
  statWin.push({ t: now, bytes: n });
  while (statWin.length && now - statWin[0].t > 2000) statWin.shift();
  if (statWin.length > 400) statWin.splice(0, statWin.length - 400);
}

export function trackDropped() {
  statDropped += 1;
}

export function useStreamStats() {
  const [s, setS] = useState({ total: statTotal, rate: 0, fps: 0, dropped: statDropped });
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      while (statWin.length && now - statWin[0].t > 2000) statWin.shift();
      const sum = statWin.reduce((a, e) => a + e.bytes, 0);
      const dt = statWin.length ? (now - statWin[0].t) / 1000 : 0;
      const span = statWin.length > 1 ? (statWin[statWin.length - 1].t - statWin[0].t) / 1000 : 0;
      setS({
        total: statTotal,
        rate: dt > 0.2 ? sum / dt : 0,
        fps: span > 0.3 ? Math.round(statWin.length / span) : 0,
        dropped: statDropped,
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return s;
}
export function useCursor() {
  const [pos, setPos] = useState(null);
  const posRef = useRef(null);
  const viewRef = useRef({ w: 0, h: 0 });
  const frameRef = useRef({ w: 0, h: 0 });
  const cropRef = useRef(null);

  function push(x, y) {
    if (typeof x !== "number" || typeof y !== "number") return;
    const p = posRef.current;
    if (p && Math.abs(p.x - x) < MOVE_EPS && Math.abs(p.y - y) < MOVE_EPS) return;
    const n = { x, y };
    posRef.current = n;
    setPos(n);
  }

  useEffect(() => {
    return addListener((event) => {
      if (event.t === "cur") push(event.cx, event.cy);
    });
  }, []);

  function feed(frame) {
    if (frame?.w && frame?.h) frameRef.current = { w: frame.w, h: frame.h };
    if (typeof frame?.cx === "number" && typeof frame?.cy === "number") push(frame.cx, frame.cy);
    if (!frame?._dropped) trackFrameBytes(frame?.jpeg?.length);
  }

  function dot() {
    if (!pos) return null;
    const v = viewRef.current;
    if (!v.w || !v.h) return null;
    const f = frameRef.current;
    const p = cursorPixels(pos.x, pos.y, v.w, v.h, f.w, f.h, cropRef.current);
    if (!p.visible) return null;
    return <CursorDot x={p.x} y={p.y} />;
  }

  return {
    feed,
    dot,
    viewRef,
    setCrop: (c) => {
      cropRef.current = c;
    },
  };
}

const styles = StyleSheet.create({
  ring: {
    position: "absolute",
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2,
    borderColor: "#38bdf8",
    backgroundColor: "transparent",
  },
});
