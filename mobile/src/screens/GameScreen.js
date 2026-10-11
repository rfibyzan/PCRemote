/**
 * GAME mode (existing "Game" entry): landscape fullscreen PC screen with a
 * semi-transparent virtual Xbox overlay, multitouch, gamepad protocol and
 * cross-tab audio (the StreamControls toggle owns it; GAME never auto-
 * starts or stops it). GAME shows the same shared StreamControls
 * (Low/Mid/High/Custom + Q/fps steppers + stream stats) as the other
 * modes — one quality system.
 *
 * Lifecycle: enter locks landscape + starts screen/gamepad; exit releases
 * every button, centers sticks, resets triggers, sends the zero state +
 * gamepadEnd, restores crop zoom + orientation. One screen subscription
 * exists only while mounted, so GAME->PAD->GAME never duplicates sessions.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ScreenOrientation from "expo-screen-orientation";
import * as SecureStore from "expo-secure-store";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { ScreenView } from "../components";
import { StreamControls, setSel } from "../controls";
import { useCursor } from "../cursor";
import { getCommittedCrop, setCommittedCrop } from "../viewer";
import { msg } from "../protocol";
import { addListener, getStatus, send } from "../connection";
import { GamepadState } from "../game/GamepadState";
import { computeMetrics, computeRects, hitTest, pageRects, sanitizeLayout, CLUSTER_GAP, FACE_GAP, PAIR_GAP, ZONE_BUTTON } from "../game/geometry";

const STORE_LAYOUT = "pcremote.gamelayout";
// On-screen touch diagnostics (works in standalone APK builds where Metro
// logs are invisible). Controls report start/end here; the overlay shows
// live fingers + pad values so dual-analog can be proven on-device.
const touchDbg = { active: new Map(), lastT: 0, lastC: 0, lastAt: "" };
let dbgListener = null;
function dbgNotify() {
  try {
    dbgListener?.();
  } catch {
    // overlay updates never break input
  }
}
// The router sees every pointer at once (one responder), so the touch list is
// read exactly once per event: changedTouches to learn which finger(s) just
// landed, touches for the live set during a move.
function changedOnes(e) {
  const n = e?.nativeEvent;
  if (Array.isArray(n?.changedTouches) && n.changedTouches.length) return n.changedTouches;
  if (Array.isArray(n?.touches)) return n.touches;
  return [];
}
function allTouches(e) {
  const n = e?.nativeEvent;
  if (Array.isArray(n?.touches)) return n.touches;
  if (Array.isArray(n?.changedTouches) && n.changedTouches.length) return n.changedTouches;
  return [];
}
// All movable overlay clusters. `top` is legacy (mapped to topBar).
const CLUSTER_IDS = ["left", "right", "topBar", "shoulderL", "shoulderR"];
const CLUSTER_LABEL = { left: "Left", right: "Right", topBar: "Top", shoulderL: "LB/LT", shoulderR: "RT/RB" };
const DEFAULT_LAYOUT = {
  left: { x: 0, y: 0, s: 1 },
  right: { x: 0, y: 0, s: 1 },
  topBar: { x: 0, y: 0, s: 1 },
  shoulderL: { x: 0, y: 0, s: 1 },
  shoulderR: { x: 0, y: 0, s: 1 },
};

function cleanLayout(raw) {
  const out = {};
  for (const id of CLUSTER_IDS) {
    // Migrate legacy `top` -> `topBar` so old installs keep their offset.
    const p = raw?.[id] ?? (id === "topBar" ? raw?.top : undefined) ?? {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    out[id] = {
      x: Math.max(-400, Math.min(400, num(p.x, 0))),
      y: Math.max(-400, Math.min(400, num(p.y, 0))),
      s: Math.max(0.5, Math.min(2, num(p.s, 1))),
    };
  }
  return out;
}

// ---- Zone visual store -------------------------------------------------
// The root touch router drives every control; controls are pure visuals and
// subscribe here so ONLY the touched control re-renders (a single setState in
// the parent would re-render the whole screen, video included, at 60fps).
const zoneStore = { knob: {}, pressed: {}, listeners: new Set() };
function emitZone() {
  for (const fn of [...zoneStore.listeners]) {
    try {
      fn();
    } catch {
      // one bad subscriber must not break the router
    }
  }
}
function setKnobVisual(zone, v) {
  const p = zoneStore.knob[zone] || {};
  if (Math.abs((p.x || 0) - v.x) < 0.5 && Math.abs((p.y || 0) - v.y) < 0.5) return;
  zoneStore.knob[zone] = v;
  emitZone();
}
function setPressedVisual(zone, on) {
  if (Boolean(zoneStore.pressed[zone]) === Boolean(on)) return;
  zoneStore.pressed[zone] = Boolean(on);
  emitZone();
}
function resetZoneVisuals() {
  zoneStore.knob = {};
  zoneStore.pressed = {};
  emitZone();
}
function useZoneVisual() {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((x) => x + 1);
    zoneStore.listeners.add(fn);
    return () => zoneStore.listeners.delete(fn);
  }, []);
  return zoneStore;
}

// Analog stick: pure visual. All gesture ownership lives in the GameScreen
// root router (one responder, one place, identifier-tracked), which is what
// finally made two simultaneous sticks possible on Android.
function Stick({ side, r, zone }) {
  const R = r || 62;
  const K = Math.round(R * 0.42);
  const v = useZoneVisual();
  const knob = v.knob[zone] || { x: 0, y: 0 };
  return (
    <View style={[styles.stick, { width: R * 2, height: R * 2, borderRadius: R }]}>
      <View
        style={[styles.knob, { width: K * 2, height: K * 2, borderRadius: K, transform: [{ translateX: knob.x }, { translateY: knob.y }] }]}
      />
    </View>
  );
}

// Gameplay button: pure visual (router owns press/release).
function PadButton({ label, zone, style, textStyle }) {
  const v = useZoneVisual();
  const pressed = Boolean(v.pressed[zone]);
  return (
    <View style={[styles.faceBtn, style, pressed && styles.faceBtnPressed]}>
      <Text style={[styles.faceText, textStyle]}>{label}</Text>
    </View>
  );
}

// Analogue trigger: pure visual (router owns the slide).
function Trigger({ label, zone, style }) {
  const v = useZoneVisual();
  const pressed = Boolean(v.pressed[zone]);
  return (
    <View style={[styles.trigger, style, pressed && styles.faceBtnPressed]}>
      <Text style={styles.faceText}>{label}</Text>
    </View>
  );
}

// System bar buttons stay native Pressables: they live in the chrome strip,
// are never part of gameplay multitouch, and must keep working when the root
// router declines a gesture (hitTest returned null).
function SysPadButton({ label, name, pad, flush }) {
  return (
    <Pressable
      onPressIn={() => {
        pad.setButton(name, true);
        flush();
      }}
      onPressOut={() => {
        pad.setButton(name, false);
        flush();
      }}
      style={({ pressed: p }) => [styles.sysBtn, p && styles.faceBtnPressed]}
    >
      <Text style={styles.streamText}>{label}</Text>
    </Pressable>
  );
}

export default function GameScreen({ onExit }) {
  const pad = useMemo(() => new GamepadState(), []);
  const exitRef = useRef(false);
  // Controls are pure visuals; the root router owns every gameplay touch and
  // releases whatever it holds the moment the screen unmounts.
  useEffect(() => () => resetZoneVisuals(), []);
  const [showStream, setShowStream] = useState(false);
  const [showDbg, setShowDbg] = useState(false);
  const [, setDbgTick] = useState(0);
  useEffect(() => {
    dbgListener = () => setDbgTick((x) => x + 1);
    return () => {
      dbgListener = null;
    };
  }, []);

  function dbgLines() {
    const ids = [...touchDbg.active.entries()].map(([id, label]) => `${label}#${String(id)}`);
    let snap = "";
    try {
      const s = pad.snapshot();
      snap = `L ${s.lx.toFixed(2)},${s.ly.toFixed(2)} R ${s.rx.toFixed(2)},${s.ry.toFixed(2)} btn ${s.buttons.toString(16)}`;
    } catch {
      snap = "?";
    }
    return [
      `root t=${touchDbg.lastT} ch=${touchDbg.lastC} @${touchDbg.lastAt}`,
      `aktif: ${ids.join(" ") || "-"}`,
      `pad: ${snap}`,
      `box ${Math.round(W)}x${Math.round(H)} @${Math.round(origin.x)},${Math.round(origin.y)}`,
      `layout ${CLUSTER_IDS.map((id) => `${id.slice(0, 3)}${Math.round(layoutRef.current[id]?.x || 0)},${Math.round(layoutRef.current[id]?.y || 0)}`).join(" ")}`,
    ];
  }
  const prevCropRef = useRef(null);
  // ViGEm backend status pushed by the agent ({t:"gamepad",on,error}).
  // Without this the pad fails silently when the PC lacks ViGEmClient.dll.
  const [padStatus, setPadStatus] = useState(null);
  const cursor = useCursor();
  const insets = useSafeAreaInsets();
  // GAME-local zoom (video only, never touches the stream crop): transient
  // Animated transform at 60fps, focal anchor, clamp, double-tap Fit/2x.
  const zScale = useRef(new Animated.Value(1)).current;
  const zPan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const zLive = useRef({ s: 1, tx: 0, ty: 0 });
  const zPrevD = useRef(0);
  const zPanLast = useRef({ x: 0, y: 0 });
  const zTap = useRef({ t: 0, x: 0, y: 0 });

  const zApply = useCallback((s, tx, ty) => {
    const vw = cursor.viewRef.current.w || 1;
    const vh = cursor.viewRef.current.h || 1;
    const mx = Math.max(0, (vw * s - vw) / 2);
    const my = Math.max(0, (vh * s - vh) / 2);
    const c = {
      s: Math.max(1, Math.min(8, s)),
      tx: Math.max(-mx, Math.min(mx, tx)),
      ty: Math.max(-my, Math.min(my, ty)),
    };
    zLive.current = c;
    zScale.setValue(c.s);
    zPan.setValue({ x: c.tx, y: c.ty });
  }, [cursor.viewRef, zScale, zPan]);

  const zAnimateTo = useCallback((s, tx, ty) => {
    const vw = cursor.viewRef.current.w || 1;
    const vh = cursor.viewRef.current.h || 1;
    const mx = Math.max(0, (vw * s - vw) / 2);
    const my = Math.max(0, (vh * s - vh) / 2);
    const c = {
      s: Math.max(1, Math.min(8, s)),
      tx: Math.max(-mx, Math.min(mx, tx)),
      ty: Math.max(-my, Math.min(my, ty)),
    };
    zLive.current = c;
    Animated.parallel([
      Animated.timing(zScale, { toValue: c.s, duration: 150, useNativeDriver: true }),
      Animated.timing(zPan, { toValue: { x: c.tx, y: c.ty }, duration: 150, useNativeDriver: true }),
    ]).start();
  }, [cursor.viewRef, zScale, zPan]);

  const zoomResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (e) =>
          e.nativeEvent.touches.length >= 2 || zLive.current.s > 1.02,
        onMoveShouldSetPanResponder: (e) =>
          e.nativeEvent.touches.length >= 2 || zLive.current.s > 1.02,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const touches = e.nativeEvent.touches || [];
          if (touches.length === 2) {
            const dx = touches[0].pageX - touches[1].pageX;
            const dy = touches[0].pageY - touches[1].pageY;
            zPrevD.current = Math.hypot(dx, dy);
          } else if (touches.length === 1) {
            // Double-tap toggles Fit / 2x.
            const t = touches[0];
            const now = Date.now();
            const last = zTap.current;
            if (now - last.t < 300 && Math.hypot(t.pageX - last.x, t.pageY - last.y) < 40) {
              zTap.current = { t: 0, x: 0, y: 0 };
              const target = zLive.current.s > 1.5 ? 1 : 2;
              zAnimateTo(target, 0, 0);
            }
            zPrevD.current = 0;
            zPanLast.current = { x: 0, y: 0 };
          }
        },
        onPanResponderMove: (e, gs) => {
          const touches = e.nativeEvent.touches || [];
          const vw = cursor.viewRef.current.w || 1;
          const vh = cursor.viewRef.current.h || 1;
          const cx = vw / 2;
          const cy = vh / 2;
          if (touches.length >= 2) {
            const dx = touches[0].pageX - touches[1].pageX;
            const dy = touches[0].pageY - touches[1].pageY;
            const d = Math.max(1, Math.hypot(dx, dy));
            const prev = zPrevD.current || d;
            zPrevD.current = d;
            const L = zLive.current;
            const ratio = d / Math.max(1, prev);
            const s = Math.max(1, Math.min(8, L.s * ratio));
            const ax = (touches[0].pageX + touches[1].pageX) / 2;
            const ay = (touches[0].pageY + touches[1].pageY) / 2;
            const fbx = cx + (ax - cx - L.tx) / Math.max(0.01, L.s);
            const fby = cy + (ay - cy - L.ty) / Math.max(0.01, L.s);
            const tx = ax - cx - (fbx - cx) * s;
            const ty = ay - cy - (fby - cy) * s;
            zApply(s, tx, ty);
          } else if (touches.length === 1 && zLive.current.s > 1.02) {
            // Pan follows finger deltas incrementally (translation-invariant).
            const L = zLive.current;
            const incX = gs.dx - zPanLast.current.x;
            const incY = gs.dy - zPanLast.current.y;
            zPanLast.current = { x: gs.dx, y: gs.dy };
            zApply(L.s, L.tx + incX, L.ty + incY);
          }
        },
        onPanResponderRelease: (e, gs) => {
          const touches = e.nativeEvent?.touches || [];
          if (touches.length === 0 && Math.abs(gs.dx) < 8 && Math.abs(gs.dy) < 8 && gs.numberActiveTouches <= 1) {
            const t = Date.now();
            zTap.current = { t, x: gs.x0 || 0, y: gs.y0 || 0 };
          }
          zPrevD.current = 0;
        },
        onPanResponderTerminate: () => {
          zPrevD.current = 0;
        },
      }),
    [zAnimateTo, zApply, cursor.viewRef],
  );
  // Custom cluster layout (persisted): offsets in dp + scale per cluster.
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [editMode, setEditMode] = useState(false);
  const [selCluster, setSelCluster] = useState("left");
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;

  function persistLayout(next) {
    SecureStore.setItemAsync(STORE_LAYOUT, JSON.stringify(next)).catch(() => {});
  }

  // Stable for responder closures (refs only).
  const moveCluster = useCallback((id, x, y, save) => {
    const cur = layoutRef.current[id] || { x: 0, y: 0, s: 1 };
    const next = {
      ...layoutRef.current,
      [id]: {
        ...cur,
        x: Math.max(-400, Math.min(400, Math.round(x))),
        y: Math.max(-400, Math.min(400, Math.round(y))),
      },
    };
    layoutRef.current = next;
    setLayout(next);
    if (save) persistLayout(next);
  }, []);

  function sizeCluster(d) {
    const id = selCluster;
    const cur = layoutRef.current[id] || { x: 0, y: 0, s: 1 };
    const s = Math.max(0.5, Math.min(2, Math.round((cur.s + d) * 10) / 10));
    const next = { ...layoutRef.current, [id]: { ...cur, s } };
    layoutRef.current = next;
    setLayout(next);
    persistLayout(next);
  }

  function resetLayout() {
    const next = { ...DEFAULT_LAYOUT };
    layoutRef.current = next;
    setLayout(next);
    persistLayout(next);
  }

  // Edit-mode drag covers: one responder per cluster, claimed only in edit
  // mode so game touches pass through untouched during play. Keyed by id so
  // adding clusters can never misalign responder <-> cover.
  const coverBase = useRef({ x: 0, y: 0 });
  const coverResponders = useMemo(() => {
    const map = {};
    for (const id of CLUSTER_IDS) {
      map[id] = PanResponder.create({
        onStartShouldSetPanResponder: () => editModeRef.current,
        onMoveShouldSetPanResponder: () => editModeRef.current,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const p = layoutRef.current[id] || { x: 0, y: 0 };
          coverBase.current = { x: p.x, y: p.y };
          setSelCluster(id);
        },
        onPanResponderMove: (e, gs) => {
          moveCluster(id, coverBase.current.x + gs.dx, coverBase.current.y + gs.dy, false);
        },
        onPanResponderRelease: (e, gs) => {
          moveCluster(id, coverBase.current.x + gs.dx, coverBase.current.y + gs.dy, true);
        },
        onPanResponderTerminate: () => {},
      });
    }
    return map;
  }, [moveCluster]);
  // The GAME screen locks landscape ASYNCHRONOUSLY, so window dimensions read
// during mount are often still the portrait ones. Right-anchored hit zones
// computed from those land ~halfway across the screen and become dead. The
// root view's OWN measured layout is the only trustworthy size, and its page
// origin must be subtracted because touches arrive in page (window) space.
const { width: winW, height: winH } = useWindowDimensions();
  const rootRef = useRef(null);
  const [rootBox, setRootBox] = useState(null); // {w,h,x,y} in page space
  const [boxTick, setBoxTick] = useState(0);
  const measureRoot = useCallback(() => {
    const node = rootRef.current;
    if (!node) return;
    try {
      node.measure((x, y, w, h, px, py) => {
        const box = { w, h, x: Number.isFinite(px) ? px : x, y: Number.isFinite(py) ? py : y };
        setRootBox((prev) => {
          if (prev && prev.w === box.w && prev.h === box.h && prev.x === box.x && prev.y === box.y) return prev;
          return box;
        });
      });
    } catch {
      // measure is best-effort; layout data still drives the metrics
    }
  }, []);
  // Rotation must invalidate the geometry even when onLayout does not re-fire.
  useEffect(() => {
    const sub = Dimensions.addEventListener("change", () => setBoxTick((t) => t + 1));
    return () => {
      try {
        sub?.remove?.();
      } catch {
        // older signature
      }
    };
  }, []);
  useEffect(() => {
    measureRoot();
  }, [measureRoot, boxTick, winW, winH]);
  // Single source of truth for every gameplay size. The RENDER components and
  // the touch router both read these, so a hit zone can never drift from the
  // control it belongs to.
  const { left: insetL, right: insetR, top: insetT } = insets;
  const { W, H } = rootBox || { W: winW, H: winH };
  const origin = useMemo(() => (rootBox ? { x: rootBox.x, y: rootBox.y } : { x: 0, y: 0 }), [rootBox]);
  const metrics = useMemo(
    () => computeMetrics({ W, H, insets: { left: insetL, right: insetR, top: insetT, bottom: 0 } }),
    [W, H, insetL, insetR, insetT],
  );
  const rects = useMemo(() => computeRects(metrics), [metrics]);
  const dbgRects = useMemo(() => (showDbg ? pageRects(rects, layout, origin) : []), [showDbg, rects, origin, layout]);
  const { R, dW, dH, fD, topPad, leftPad, rightPad, clusterTop, shoulderY } = metrics;

  function flush() {
    // Check-then-send (never send-then-clear): an input landing between a
    // snapshot and the clear would otherwise be swallowed — exactly the
    // "second finger press disappears" multi-input bug.
    if (pad.takeDirty()) send(msg.gamepad(pad.snapshot()));
  }

  // ---- Root touch router ------------------------------------------------
  // ONE responder for the whole GAME overlay, claimed in the capture phase so
  // the gesture can never be re-targeted mid-flight (that re-targeting is what
  // made only one stick ever receive MOVE). Every live finger is dispatched
  // here by identifier and hit-tested against the analytic geometry above, so
  // both sticks (and buttons + triggers) run off the same, stable owner.
  const fingersRef = useRef(new Map()); // identifier -> { zone, ox, oy, sy }

  function zoneOf(pageX, pageY) {
    try {
      return hitTest(rects, layoutRef.current, pageX, pageY, 0, origin);
    } catch {
      return null;
    }
  }

  function pressZone(zone, t) {
    if (zone === "stickL" || zone === "stickR") {
      // A stick snaps to centre until the finger actually moves (no jump on
      // touch), which is how a real thumb feels.
      setKnobVisual(zone, { x: 0, y: 0 });
    } else if (zone === "btnLT" || zone === "btnRT") {
      pad.setTrigger(zone === "btnLT" ? "left" : "right", 1); // tap = full press
      setPressedVisual(zone, true);
      flush();
    } else {
      const name = ZONE_BUTTON[zone];
      if (name) {
        pad.setButton(name, true);
        setPressedVisual(zone, true);
        flush();
      }
    }
    void t;
  }

  function moveZone(f, t) {
    const { zone } = f;
    if (zone === "stickL" || zone === "stickR") {
      const rr = metrics.R;
      let dx = (t.pageX - f.ox) / rr;
      let dy = -(t.pageY - f.oy) / rr; // +up
      const mag = Math.hypot(dx, dy);
      if (mag > 1) {
        dx /= mag;
        dy /= mag;
      }
      const K = metrics.K;
      pad.setStick(zone === "stickL" ? "left" : "right", dx, dy);
      setKnobVisual(zone, { x: dx * (rr - K), y: -dy * (rr - K) });
      flush();
      return;
    }
    if (zone === "btnLT" || zone === "btnRT") {
      const v = Math.max(0, Math.min(1, 1 + (t.pageY - f.sy) / 120));
      pad.setTrigger(zone === "btnLT" ? "left" : "right", v);
      flush();
    }
  }

  function releaseZone(zone) {
    if (zone === "stickL" || zone === "stickR") {
      pad.setStick(zone === "stickL" ? "left" : "right", 0, 0);
      setKnobVisual(zone, { x: 0, y: 0 });
      flush();
      return;
    }
    if (zone === "btnLT" || zone === "btnRT") {
      pad.setTrigger(zone === "btnLT" ? "left" : "right", 0);
      setPressedVisual(zone, false);
      flush();
      return;
    }
    const name = ZONE_BUTTON[zone];
    if (name) {
      pad.setButton(name, false);
      setPressedVisual(zone, false);
      flush();
    }
  }

  // A finger is BORN in two places, not one. onPanResponderGrant fires only
  // when the view BECOMES responder (the first finger) — later fingers never
  // produce a second grant, they only show up inside move events. Assigning
  // zones in grant alone therefore left every later finger zoneless: exactly
  // the "only the first side responds" symptom. So trackTouch() below is the
  // single choke point used by BOTH grant and move, and move additionally
  // releases tracked fingers that vanished (release fires on last lift only).
  function zoneTaken(zone) {
    for (const f of fingersRef.current.values()) {
      if (f.zone === zone) return true;
    }
    return false;
  }

  function nearestSynthetic(t) {
    let best = null;
    let bd = 100 * 100;
    for (const [id, f] of fingersRef.current) {
      if (typeof id !== "string" || id[0] !== "p" || typeof f.lx !== "number") continue;
      if (typeof t.pageX !== "number") continue;
      const d = (t.pageX - f.lx) * (t.pageX - f.lx) + (t.pageY - f.ly) * (t.pageY - f.ly);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  // Returns { id, f, isNew } or null (missed every zone / zone occupied).
  function trackTouch(t) {
    const rawId = t.identifier;
    if (rawId !== undefined && rawId !== null) {
      const f = fingersRef.current.get(rawId);
      if (f) return { id: rawId, f, isNew: false };
      const hit = zoneOf(t.pageX, t.pageY);
      if (!hit || zoneTaken(hit.zone)) return null;
      const nf = { zone: hit.zone, ox: t.pageX, oy: t.pageY, sy: t.pageY, lx: t.pageX, ly: t.pageY };
      fingersRef.current.set(rawId, nf);
      touchDbg.active.set(rawId, hit.zone);
      dbgNotify();
      pressZone(hit.zone, t);
      return { id: rawId, f: nf, isNew: true };
    }
    const near = nearestSynthetic(t);
    if (near) return { id: near, f: fingersRef.current.get(near), isNew: false };
    const hit = zoneOf(t.pageX, t.pageY);
    if (!hit || zoneTaken(hit.zone)) return null;
    const id = `p${Math.round(t.pageX)},${Math.round(t.pageY)}`;
    const nf = { zone: hit.zone, ox: t.pageX, oy: t.pageY, sy: t.pageY, lx: t.pageX, ly: t.pageY };
    fingersRef.current.set(id, nf);
    touchDbg.active.set(id, hit.zone);
    dbgNotify();
    pressZone(hit.zone, t);
    return { id, f: nf, isNew: true };
  }

  function forgetFinger(id) {
    const st = fingersRef.current.get(id);
    if (!st) return;
    fingersRef.current.delete(id);
    touchDbg.active.delete(id);
    dbgNotify();
    try {
      releaseZone(st.zone);
    } catch {
      // ignore
    }
  }

  function releaseAllFingers() {
    for (const id of [...fingersRef.current.keys()]) forgetFinger(id);
  }

  const touchRouter = useMemo(
    () =>
      PanResponder.create({
        // Claim only when the gesture STARTS on a gameplay control. Chrome
        // (Exit/Stream/Layout/Dbg) and the video keep their native handlers,
        // so nothing else in the screen regresses.
        onStartShouldSetPanResponderCapture: (e) => {
          if (editModeRef.current) return false;
          const list = changedOnes(e);
          for (const t of list) {
            if (zoneOf(t.pageX, t.pageY)) return true;
          }
          return false;
        },
        onMoveShouldSetPanResponderCapture: () => false,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (e) => {
          const landed = changedOnes(e);
          touchDbg.lastT = allTouches(e).length;
          touchDbg.lastC = landed.length;
          for (const t of landed) trackTouch(t);
        },
        onPanResponderMove: (e) => {
          const all = allTouches(e);
          touchDbg.lastT = all.length;
          const seen = new Set();
          for (const t of all) {
            // A finger that landed without a fresh grant (second, third…)
            // is assigned here on its first observed move.
            const r = trackTouch(t);
            if (!r) continue;
            const { id, f } = r;
            seen.add(id);
            if (typeof t.pageX === "number") {
              f.lx = t.pageX;
              f.ly = t.pageY;
            }
            try {
              moveZone(f, t);
            } catch {
              // one bad zone must not break the rest
            }
          }
          // A tracked finger absent from the live set has lifted mid-gesture
          // (release only fires when the LAST finger lifts).
          for (const id of [...fingersRef.current.keys()]) {
            if (!seen.has(id)) forgetFinger(id);
          }
        },
        onPanResponderRelease: () => {
          releaseAllFingers();
        },
        onPanResponderTerminate: () => {
          releaseAllFingers();
        },
      }),
    // rects/metrics/layout are read through refs; the router is built once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Stall watchdog (same 4s policy as ViewerPanel): if a tab-switch race
  // ever stops our frames, show a banner and re-assert screen(true) instead
  // of freezing on the last frame forever. cursor.feed is wrapped so every
  // real frame (even display-dropped ones) resets the timer.
  const lastFrameAt = useRef(Date.now());
  const lastResendAt = useRef(0);
  const [stalled, setStalled] = useState(false);
  const stallTimer = useRef(null);
  function onGameFrame(f) {
    lastFrameAt.current = Date.now();
    if (stalled) setStalled(false);
    cursor.feed(f);
  }



  useEffect(() => {
    exitRef.current = false;
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    activateKeepAwakeAsync().catch(() => {});
    SecureStore.getItemAsync(STORE_LAYOUT).then((raw) => {
      try {
        const saved = JSON.parse(raw || "null");
        if (saved) {
          // clean = shape/clamp; sanitize additionally keeps offsets inside the
          // screen so a cluster can never end up permanently unreachable.
          const shaped = cleanLayout(saved);
          const next = sanitizeLayout(shaped, metrics.W || winW, metrics.H || winH);
          layoutRef.current = next;
          setLayout(next);
        }
      } catch {
        // defaults
      }
    }).catch(() => {});
    // Audio is cross-tab now (StreamControls toggle owns it): GAME neither
    // starts nor stops it on mount/unmount.
    // GAME always opens Fit: stash the shared tab crop, show full screen,
    // and restore the stash on exit so PAD keeps its zoom. gameLock tells
    // background ViewerPanels not to re-assert crop mid-transaction, and
    // setCommittedCrop keeps the socket-global dedup token in sync (GAME
    // sends msg.crop directly, bypassing sendCropIfChanged).
    prevCropRef.current = getCommittedCrop();
    send(msg.crop(0, 0, 1, 1));
    setCommittedCrop({ x: 0, y: 0, w: 1, h: 1 });
    setSel({ crop: { x: 0, y: 0, w: 1, h: 1 }, gameLock: true });
    const offPad = addListener((event) => {
      if (event.t === "gamepad") setPadStatus({ on: Boolean(event.on), error: event.error || "" });
    });
    // Continuous analog updates at ~30 Hz (dirty-gated); buttons flush immediately too.
    const timer = setInterval(() => {
      if (pad.takeDirty()) send(msg.gamepad(pad.snapshot()));
    }, 33);
    // Stall watchdog: re-assert the screen subscription when frames stop,
    // at most every 4s. lastFrameAt is deliberately NOT reset here so a dead
    // socket stays visibly stalled instead of looking recovered.
    lastFrameAt.current = Date.now();
    lastResendAt.current = 0;
    setStalled(false);
    stallTimer.current = setInterval(() => {
      if (exitRef.current) return;
      const idle = Date.now() - (lastFrameAt.current || Date.now());
      if (idle > 4000 && getStatus().connected) {
        setStalled(true);
        if (Date.now() - lastResendAt.current > 4000) {
          lastResendAt.current = Date.now();
          try {
            send(msg.screen(true));
          } catch {
            // best-effort
          }
        }
      } else if (idle <= 4000) {
        setStalled(false);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      if (stallTimer.current) {
        clearInterval(stallTimer.current);
        stallTimer.current = null;
      }
      offPad();
      setPadStatus(null);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    if (exitRef.current) return;
    exitRef.current = true;
    // Release any finger the router still owns BEFORE the pad is zeroed, so a
    // half-held stick/button can never outlive the screen.
    try {
      releaseAllFingers();
    } catch {
      // teardown is best-effort
    }
    resetZoneVisuals();
    try {
      pad.reset();
      send(msg.gamepad(pad.snapshot())); // all released, sticks centered
      send(msg.gamepadEnd()); // disconnect/reset virtual controller
      const prev = prevCropRef.current;
      if (prev && (prev.w < 0.995 || prev.h < 0.995)) {
        send(msg.crop(prev.x, prev.y, prev.w, prev.h)); // restore tab zoom
        setCommittedCrop({ ...prev });
        setSel({ crop: { ...prev } });
      } else {
        setCommittedCrop({ x: 0, y: 0, w: 1, h: 1 });
        setSel({ crop: { x: 0, y: 0, w: 1, h: 1 } });
      }
      setSel({ gameLock: false });
    } catch {
      // teardown is best-effort
    }
    deactivateKeepAwake().catch(() => {});
    ScreenOrientation.unlockAsync().catch(() => {});
  }

  function exit() {
    cleanup();
    onExit();
  }

  function clusterT(id) {
    const p = layout[id] || { x: 0, y: 0, s: 1 };
    return { transform: [{ translateX: p.x }, { translateY: p.y }, { scale: p.s }] };
  }

  function editCover(id) {
    if (!editMode) return null;
    const responder = coverResponders[id];
    if (!responder) return null;
    return (
      <View
        style={[styles.editCover, selCluster === id && styles.editCoverSel]}
        {...responder.panHandlers}
      />
    );
  }

  return (
    <View
      ref={rootRef}
      style={styles.root}
      // The router's capture-phase handlers live on the root: one owner for
      // every gameplay touch. Declining (hitTest null) keeps the video zoom
      // and all chrome Pressables working exactly as before.
      {...touchRouter.panHandlers}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        cursor.viewRef.current = { w: width, h: height };
        // Measure after layout so the geometry (and the page origin) describe
        // the view that actually holds the controls.
        measureRoot();
      }}
    >
      {/* Hit-boxes the router believes in. If these outlines sit on the
          controls, routing is correct; if they drift, the offset is visible
          without guessing from logs. */}
      {showDbg &&
        dbgRects.map((r) => (
          <View key={r.zone} pointerEvents="none" style={[styles.dbgRect, { left: r.x, top: r.y, width: r.w, height: r.h }]} />
        ))}
      {/* Video owns its own pinch/double-tap zoom. The root router declines
          gestures that miss every gameplay zone, so this still wins the video
          area while the sticks/buttons keep the router. */}
      <Animated.View
        style={[
          styles.screen,
          { transform: [{ scale: zScale }, { translateX: zPan.x }, { translateY: zPan.y }] },
        ]}
        {...zoomResponder.panHandlers}
      >
        <ScreenView style={styles.screenInner} onFrame={onGameFrame} />
        {cursor.dot()}
      </Animated.View>
      {/* top bar: exit + system buttons (below the status bar/notch), movable */}
      <View
        style={[styles.topBar, { top: topPad, left: leftPad, right: rightPad }, clusterT("topBar")]}
        pointerEvents="box-none"
      >
        <Pressable onPress={exit} style={styles.exitBtn}>
          <Text style={styles.exitText}>✕ Exit</Text>
        </Pressable>
        <View style={styles.sysRow}>
          <View style={styles.padDot} pointerEvents="none">
            <Text style={[styles.padDotText, padStatus?.on ? styles.padDotOn : styles.padDotOff]}>
              {padStatus?.on ? "Pad ●" : "Pad ○"}
            </Text>
          </View>
          <Pressable onPress={() => setShowStream((s) => !s)} style={styles.sysBtn}>
            <Text style={styles.streamText}>Stream</Text>
          </Pressable>
          <Pressable onPress={() => setShowDbg((s) => !s)} style={[styles.sysBtn, showDbg && styles.sysBtnActive]}>
            <Text style={styles.streamText}>Dbg</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setShowStream(false);
              setEditMode((m) => !m);
            }}
            style={[styles.sysBtn, editMode && styles.sysBtnActive]}
          >
            <Text style={styles.streamText}>Layout</Text>
          </Pressable>
          <SysPadButton label="Back" name="back" pad={pad} flush={flush} />
          <SysPadButton label="Guide" name="guide" pad={pad} flush={flush} />
          <SysPadButton label="Start" name="start" pad={pad} flush={flush} />
        </View>
        {editCover("topBar")}
      </View>
      {showStream && (
        <View style={styles.streamCenter} pointerEvents="box-none">
          <View style={styles.streamPanel} pointerEvents="auto">
            <StreamControls compact />
          </View>
        </View>
      )}
      {showDbg && (
        <View style={[styles.dbgBox, { top: topPad + 44, left: leftPad, right: rightPad }]} pointerEvents="none">
          {dbgLines().map((line, i) => (
            <Text key={i} style={styles.dbgText} numberOfLines={1}>{line}</Text>
          ))}
        </View>
      )}
      {!!(padStatus && !padStatus.on && padStatus.error) && (
        <View style={[styles.padErr, { top: topPad + 44, left: leftPad, right: rightPad }]} pointerEvents="none">
          <Text style={styles.padErrText} numberOfLines={2}>{padStatus.error}</Text>
        </View>
      )}
      {stalled && (
        <View style={[styles.stalled, { top: topPad + 44, left: leftPad, right: rightPad }]} pointerEvents="none">
          <Text style={styles.stalledText} numberOfLines={2}>Stream terhenti — mencoba lagi otomatis…</Text>
        </View>
      )}
      {/* shoulders: split L/R so each side is independently movable */}
      <View
        style={[styles.shoulderL, { top: shoulderY, left: leftPad }, clusterT("shoulderL")]}
        pointerEvents="box-none"
      >
        <View style={styles.shoulderSide}>
          <PadButton label="LB" zone="btnLB" style={styles.bumper} />
          <Trigger label="LT" zone="btnLT" style={styles.triggerBtn} />
        </View>
        {editCover("shoulderL")}
      </View>
      <View
        style={[styles.shoulderR, { top: shoulderY, right: rightPad }, clusterT("shoulderR")]}
        pointerEvents="box-none"
      >
        <View style={styles.shoulderSide}>
          <Trigger label="RT" zone="btnRT" style={styles.triggerBtn} />
          <PadButton label="RB" zone="btnRB" style={styles.bumper} />
        </View>
        {editCover("shoulderR")}
      </View>
      {/* left column: stick above, dpad below — anchored below the shoulders
          using the SAME clusterTop the hit-test geometry uses. */}
      <View
        style={[styles.leftCluster, { left: leftPad, top: clusterTop }, clusterT("left")]}
        pointerEvents="box-none"
      >
        <Stick r={R} zone="stickL" />
        <View style={[styles.dpad, { gap: PAIR_GAP }]}>
          <PadButton label="▲" zone="dpadUp" style={[styles.dUp, { width: dW, height: dH }]} />
          <View style={[styles.dMid, { gap: PAIR_GAP }]}>
            <PadButton label="◀" zone="dpadLeft" style={[styles.dSide, { width: dW, height: dH }]} />
            <PadButton label="▶" zone="dpadRight" style={[styles.dSide, { width: dW, height: dH }]} />
          </View>
          <PadButton label="▼" zone="dpadDown" style={[styles.dUp, { width: dW, height: dH }]} />
        </View>
        {editCover("left")}
      </View>
      {/* right column: face buttons above, stick below — same anchor as left. */}
      <View
        style={[styles.rightCluster, { right: rightPad, top: clusterTop }, clusterT("right")]}
        pointerEvents="box-none"
      >
        <View style={[styles.face, { gap: FACE_GAP }]}>
          <PadButton label="Y" zone="faceY" style={[styles.fUp, { width: fD, height: fD, borderRadius: fD / 2 }]} textStyle={styles.fY} />
          <View style={[styles.dMid, { gap: PAIR_GAP }]}>
            <PadButton label="X" zone="faceX" style={[styles.dSideFace, { width: fD, height: fD, borderRadius: fD / 2 }]} textStyle={styles.fX} />
            <PadButton label="B" zone="faceB" style={[styles.dSideFace, { width: fD, height: fD, borderRadius: fD / 2 }]} textStyle={styles.fB} />
          </View>
          <PadButton label="A" zone="faceA" style={[styles.fUp, { width: fD, height: fD, borderRadius: fD / 2 }]} textStyle={styles.fA} />
        </View>
        <Stick r={R} zone="stickR" />
        {editCover("right")}
      </View>
      {editMode && (
        <View style={styles.editPanel} pointerEvents="box-none">
          <View style={styles.editBox} pointerEvents="auto">
            <View style={styles.editRow}>
              {CLUSTER_IDS.map((id) => (
                <Pressable
                  key={id}
                  onPress={() => setSelCluster(id)}
                  style={[styles.editChip, selCluster === id && styles.editChipActive]}
                >
                  <Text style={styles.editText}>{CLUSTER_LABEL[id] || id}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.editRow}>
              <Pressable onPress={() => sizeCluster(-0.1)} style={styles.editChip}>
                <Text style={styles.editText}>−</Text>
              </Pressable>
              <Text style={styles.editText}>{Math.round((layout[selCluster]?.s || 1) * 100)}%</Text>
              <Pressable onPress={() => sizeCluster(0.1)} style={styles.editChip}>
                <Text style={styles.editText}>+</Text>
              </Pressable>
              <Pressable onPress={resetLayout} style={styles.editChip}>
                <Text style={styles.editText}>Reset</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  persistLayout(layoutRef.current);
                  setEditMode(false);
                }}
                style={[styles.editChip, styles.editChipActive]}
              >
                <Text style={styles.editText}>Done</Text>
              </Pressable>
            </View>
            <Text style={styles.editHint}>Drag a highlighted cluster to move it</Text>
            <Text style={styles.editHint}>
              {`${CLUSTER_LABEL[selCluster] || selCluster}: x=${Math.round(layout[selCluster]?.x || 0)} y=${Math.round(layout[selCluster]?.y || 0)}`}
              {(Math.abs(layout[selCluster]?.x || 0) > 300 || Math.abs(layout[selCluster]?.y || 0) > 250)
                ? " · awas off-screen"
                : ""}
            </Text>
            <Text style={styles.editHint}>Jika tombol menumpuk, geser salah satu cluster menjauh lalu Done</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const BTN = "rgba(30,41,59,0.72)";
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  screen: { ...StyleSheet.absoluteFillObject },
  screenInner: { flex: 1 },
  topBar: { position: "absolute", top: 8, left: 8, right: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  exitBtn: { backgroundColor: BTN, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  exitText: { color: "#e8eefc", fontWeight: "800", fontSize: 12 },
  sysRow: { flexDirection: "row", gap: 6 },
  sysBtn: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: BTN },
  sysBtnActive: { backgroundColor: "rgba(12,74,110,0.9)" },
  streamText: { color: "#e8eefc", fontWeight: "800", fontSize: 12 },
  streamCenter: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  streamPanel: { width: 320, maxWidth: "80%", backgroundColor: "rgba(11,18,32,0.94)", borderRadius: 12, borderWidth: 1, borderColor: "#1e293b" },
  padDot: { paddingVertical: 8, paddingHorizontal: 6, justifyContent: "center" },
  padDotText: { fontWeight: "800", fontSize: 12 },
  padDotOn: { color: "#4ade80" },
  padDotOff: { color: "#94a3b8" },
  padErr: { position: "absolute", top: 48, left: 8, right: 8, backgroundColor: "rgba(127,29,29,0.85)", borderRadius: 10, padding: 8 },
  padErrText: { color: "#e8eefc", fontSize: 11, fontWeight: "700" },
  dbgBox: { position: "absolute", backgroundColor: "rgba(11,18,32,0.9)", borderRadius: 10, padding: 8, gap: 2 },
  dbgRect: { position: "absolute", borderWidth: 1, borderColor: "rgba(74,222,128,0.9)", backgroundColor: "rgba(74,222,128,0.12)", borderRadius: 4 },
  dbgText: { color: "#4ade80", fontSize: 11, fontWeight: "700", fontFamily: "monospace" },
  stalled: { position: "absolute", backgroundColor: "rgba(127,29,29,0.9)", borderRadius: 10, padding: 8 },
  stalledText: { color: "#e8eefc", fontSize: 11, fontWeight: "700", textAlign: "center" },
  editCover: { ...StyleSheet.absoluteFillObject, borderWidth: 2, borderStyle: "dashed", borderColor: "rgba(125,211,252,0.5)", borderRadius: 12 },
  editCoverSel: { borderColor: "#38bdf8", backgroundColor: "rgba(56,189,248,0.08)" },
  editPanel: { position: "absolute", left: 0, right: 0, bottom: 12, alignItems: "center" },
  editBox: { backgroundColor: "rgba(11,18,32,0.94)", borderRadius: 12, borderWidth: 1, borderColor: "#1e293b", padding: 8, gap: 6 },
  editRow: { flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center" },
  editChip: { backgroundColor: "#1e293b", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  editChipActive: { backgroundColor: "#0c4a6e" },
  editText: { color: "#e8eefc", fontWeight: "800", fontSize: 12 },
  editHint: { color: "#94a3b8", fontSize: 11, textAlign: "center" },
  shoulders: { position: "absolute", top: 52, left: 8, right: 8, flexDirection: "row", justifyContent: "space-between" },
  shoulderL: { position: "absolute", alignItems: "flex-start" },
  shoulderR: { position: "absolute", alignItems: "flex-end" },
  shoulderSide: { flexDirection: "row", gap: 6 },
  bumper: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  triggerBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: BTN, alignItems: "center", justifyContent: "center" },
  trigger: { backgroundColor: BTN, alignItems: "center", justifyContent: "center" },
  leftCluster: { position: "absolute", alignItems: "center", gap: CLUSTER_GAP },
  rightCluster: { position: "absolute", alignItems: "center", gap: CLUSTER_GAP },
  stick: { backgroundColor: "rgba(30,41,59,0.55)", borderWidth: 2, borderColor: "rgba(125,211,252,0.5)", alignItems: "center", justifyContent: "center" },
  knob: { backgroundColor: "rgba(125,211,252,0.75)" },
  dpad: { alignItems: "center", gap: PAIR_GAP },
  // Sizes come from metrics at call time; the defaults only prevent a 0x0
  // flash on the very first render before layout is measured.
  dUp: { width: 56, height: 56, borderRadius: 12, borderWidth: 1, borderColor: "rgba(125,211,252,0.35)", backgroundColor: "rgba(30,41,59,0.82)", alignItems: "center", justifyContent: "center" },
  dMid: { flexDirection: "row", gap: PAIR_GAP },
  dSide: { width: 56, height: 56, borderRadius: 12, borderWidth: 1, borderColor: "rgba(125,211,252,0.35)", backgroundColor: "rgba(30,41,59,0.82)", alignItems: "center", justifyContent: "center" },
  face: { alignItems: "center", gap: FACE_GAP },
  fUp: { width: 56, height: 56, borderRadius: 28, borderWidth: 1, borderColor: "rgba(125,211,252,0.35)", backgroundColor: "rgba(30,41,59,0.82)", alignItems: "center", justifyContent: "center" },
  dSideFace: { width: 56, height: 56, borderRadius: 28, borderWidth: 1, borderColor: "rgba(125,211,252,0.35)", backgroundColor: "rgba(30,41,59,0.82)", alignItems: "center", justifyContent: "center" },
  // Visible surface: without it the d-pad arms and face buttons were bare
  // glyphs on the video, which is why they read as "tiny and odd" next to
  // the text-sized shoulder buttons.
  btnSurface: {
    backgroundColor: "rgba(30,41,59,0.82)",
    borderWidth: 1,
    borderColor: "rgba(125,211,252,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  faceBtn: { backgroundColor: BTN, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  faceBtnPressed: { backgroundColor: "rgba(12,74,110,0.85)" },
  faceText: { color: "#e8eefc", fontWeight: "800", fontSize: 16 },
  fY: { color: "#facc15" },
  fX: { color: "#7dd3fc" },
  fB: { color: "#f87171" },
  fA: { color: "#4ade80" },
});
