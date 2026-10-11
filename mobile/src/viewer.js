/** Universal viewer panel: Click / Look / Bar + screen + zoom + source chips.
 * Used by PAD, TYPE and WIN so the mode behavior is identical everywhere.
 * CLICK: L/R/M selector sets the tap+drag button, tap = abs click, drag = drag.
 * LOOK: camera model (src/camera.js). Pan, pinch, fling and double-tap run
 * on the UI thread (react-native-gesture-handler + Reanimated), so the view
 * follows the fingers even while the JS thread is busy decoding frames.
 * Frames are drawn on a whole-monitor canvas at the rect their header says
 * they cover; the PC is only asked for a (padded) region around the view, so
 * a new sharper region never moves the picture: no rebase, no jump.
 * BAR: scrollbar overlay. The camera is shared across PAD/TYPE/WIN.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";
import { useFocusEffect } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { COLORS, MonitorChips, ScreenView } from "./components";
import { ConnDot, StreamControls, StreamStats, getSel, setSel, useMonitorSource, useSel } from "./controls";
import { trackFrameBytes } from "./cursor";
import { msg } from "./protocol";
import { addListener, getStatus, send } from "./connection";
import { CONTROL_H, CONTROL_GAP, CONTROL_PAD } from "./tablayout";
import {
  MAX_ZOOM,
  camFor,
  camToNorm,
  clampCam,
  fitCanvas,
  maxPan,
  monitorToView,
  normToCam,
  pinchCam,
  regionCovers,
  regionFor,
  resolveCrop,
  rubber,
  viewToMonitor,
  visibleRect,
  zoomAt,
} from "./camera";

const RING = 22;
const ZOOM_MS = 220;
// While moving we ask for a roomy region so small pans need no new crop;
// once the camera rests we ask for a tight one so the view is sharp.
const PAD_MOVING = 0.8;
const PAD_REST = 0.3;
const STRETCH_MOVING = 2.6;
const STRETCH_REST = 1.7;

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

const CLICK_BTNS = [
  { id: "left", label: "L" },
  { id: "right", label: "R" },
  { id: "middle", label: "M" },
];

// Socket-global last-sent crop (shared by all panels + GAME Fit/restore).
// The agent keeps ONE crop per socket, so duplicates across panels would
// re-encode identically and look like flicker.
let lastSentCrop = null;
// Recent crops we asked for, newest last: frame headers quantize the crop to
// 1/255, so frames are snapped back to the exact region before placement.
const sentCrops = [];
function rememberCrop(c) {
  sentCrops.push({ ...c });
  if (sentCrops.length > 16) sentCrops.splice(0, sentCrops.length - 16);
}
function snapCrop(header) {
  const list = lastSentCrop ? [...sentCrops, lastSentCrop] : sentCrops;
  return resolveCrop(header, list);
}

export function getCommittedCrop() {
  return lastSentCrop ? { ...lastSentCrop } : null;
}

// GAME bypasses ViewerPanel (it sends msg.crop directly), so it must keep
// this in sync or post-exit commits will be skipped/duplicated as stale.
export function setCommittedCrop(c) {
  lastSentCrop = c ? { ...c } : null;
  if (c) rememberCrop(c);
}

export default function ViewerPanel({ title = "", touchpad = true, actions = true, onTap = null, children = null }) {
  // Layout C: header row + viewer (flex: 1) + fixed CONTROL_H area. The
  // control area is identical on PAD / TYPE / WIN, so the viewer is too.
  // Shared across PAD/TYPE/WIN tabs: mode, source, click button and crop.
  const shared = useSel();
  const sub = shared.mode;
  const bar = shared.bar;
  const clickBtn = shared.clickBtn;
  const crop = shared.crop;
  const { monitors, current, camError, pick } = useMonitorSource();
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const clickBtnRef = useRef(clickBtn);
  clickBtnRef.current = clickBtn;
  // Optional WIN-only hook: release held Alt-Tab when the viewer is tapped.
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const viewSize = useRef({ w: 0, h: 0 });
  const frameSize = useRef({ w: 0, h: 0 });
  const wrapRef = useRef(null);
  // Viewer origin in page coords (for pinch midpoints). locationX/Y are
  // unreliable on some Android builds, so page-minus-origin is primary.
  const originRef = useRef(null);
  function measureOrigin() {
    try {
      wrapRef.current?.measure((x, y, w, h, px, py) => {
        if (Number.isFinite(px) && Number.isFinite(py)) originRef.current = { x: px, y: py };
      });
    } catch {
      // measurement is best-effort; center fallback remains
    }
  }
  const cropTimer = useRef(null);
  const lastRef = useRef(null);
  const dragRef = useRef(false);
  const vTouch = useRef(null);
  const barDrag = useRef(null);
  // Last completed tap (for double/triple-tap word/line select).
  const tapRef = useRef({ t: 0, x: 0, y: 0 });
  // Zoom slider (Look, right edge): absolute 1x..MAX_ZOOM, centre-anchored.
  const [trackH, setTrackH] = useState(0);
  const trackHRef = useRef(0);
  // CAMERA (UI thread). s = zoom (1 = Fit), tx/ty = view px. JS keeps a
  // mirror (camRef) for tap mapping, region requests, minimap and badge.
  const camS = useSharedValue(1);
  const camX = useSharedValue(0);
  const camY = useSharedValue(0);
  const vwS = useSharedValue(0);
  const vhS = useSharedValue(0);
  const aspectS = useSharedValue(16 / 9);
  const curX = useSharedValue(-1);
  const curY = useSharedValue(-1);
  const lastSyncS = useSharedValue(0);
  const camRef = useRef({ s: 1, tx: 0, ty: 0 });
  const aspectRef = useRef(0); // 0 = monitor shape unknown yet
  // Re-render trigger for minimap / badge / slider (~10 Hz while moving).
  const [, setCamTick] = useState(0);
  const tickTimer = useRef(null);
  const regionAt = useRef(0);
  const lastFrameAt = useRef(0);
  const lastResendAt = useRef(0);
  const [cur, setCur] = useState(null);
  const curRef = useRef(null);
  const [stalled, setStalled] = useState(false);
  const stallTimer = useRef(null);
  const focusGen = useRef(0);
  // Transient "tap ignored" notice when true monitor dims aren't ready yet.
  // Taps must never mis-fire, but silence feels like a dead screen.
  const [tapBlocked, setTapBlocked] = useState(false);
  const tapBlockedTimer = useRef(null);
  function noteBlocked() {
    setTapBlocked(true);
    if (tapBlockedTimer.current) clearTimeout(tapBlockedTimer.current);
    tapBlockedTimer.current = setTimeout(() => {
      tapBlockedTimer.current = null;
      setTapBlocked(false);
    }, 1500);
  }
  useEffect(() => {
    return addListener((event) => {
      if (event.t === "cur" && typeof event.cx === "number") feedCursor(event.cx, event.cy);
    });
  }, []);

  // Unmount cleanup: never leak crop/anim/rebase timers across tabs.
  // Also release any held mouse button so the PC never stays stuck DOWN.
  useEffect(() => {
    return () => {
      releaseHoldSilent();
      try {
        deactivateKeepAwake().catch(() => {});
      } catch {
        // best-effort
      }
      if (cropTimer.current) clearTimeout(cropTimer.current);
      if (tickTimer.current) clearTimeout(tickTimer.current);
      if (stallTimer.current) clearInterval(stallTimer.current);
      if (tapBlockedTimer.current) clearTimeout(tapBlockedTimer.current);
      cropTimer.current = tickTimer.current = null;
      vTouch.current = null;
    };
  }, []);

  // Held-button safety: socket close / new hello / click-button switch must
  // never leave a DOWN without UP on the PC.
  const prevClickBtn = useRef(clickBtn);
  useEffect(() => {
    if (prevClickBtn.current !== clickBtn && dragRef.current) releaseHoldSilent();
    prevClickBtn.current = clickBtn;
  }, [clickBtn]);
  useEffect(() => {
    return addListener((event) => {
      if (event.t === "close" || event.t === "hello") {
        releaseHoldSilent();
        vTouch.current = null;
      }
    });
  }, []);

  // Cross-tab resync: the camera is shared (resolution-independent) across
  // PAD/TYPE/WIN. On focus, adopt it for this view, cancel stray gestures and
  // re-assert the shared crop so agent and client agree.
  useFocusEffect(
    useCallback(() => {
      const gen = ++focusGen.current;
      vTouch.current = null;
      adoptSharedCam();
      // Re-assert shared crop idempotently (agent dedups identical crop).
      // Skipped while GAME owns the crop — its Fit/restore transaction is
      // authoritative and a background panel must not fight it.
      try {
        if (!getSel().gameLock) {
          const c = cropRef.current;
          if (c && (c.w < 0.995 || c.h < 0.995 || c.x > 0.004 || c.y > 0.004)) {
            rememberCrop(c);
            send(msg.crop(c.x, c.y, c.w, c.h));
          }
        }
        send(msg.screen(true));
      } catch {
        // best-effort
      }
      lastFrameAt.current = Date.now();
      lastResendAt.current = 0;
      setStalled(false);
      // Long viewer sessions must not sleep mid-stream (was Game-only).
      // Best-effort: blur/unmount always releases so one stuck tab can't
      // hold the device awake forever.
      try {
        activateKeepAwakeAsync().catch(() => {});
      } catch {
        // expo-keep-awake optional on web
      }
      if (stallTimer.current) clearInterval(stallTimer.current);
      stallTimer.current = setInterval(() => {
        if (gen !== focusGen.current) return;
        const idle = Date.now() - (lastFrameAt.current || Date.now());
        if (idle > 4000 && getStatus().connected) {
          setStalled(true);
          // Soft recovery without restarting the app: re-subscribe + re-crop,
          // at most every 4s. lastFrameAt is deliberately NOT reset here so a
          // dead socket stays visibly stalled instead of looking recovered.
          if (Date.now() - lastResendAt.current > 4000) {
            lastResendAt.current = Date.now();
            try {
              send(msg.screen(true));
              const c = cropRef.current;
              if (c) send(msg.crop(c.x, c.y, c.w, c.h));
            } catch {
              // best-effort
            }
          }
        } else if (idle <= 4000) {
          setStalled(false);
        }
      }, 1000);
      return () => {
        if (stallTimer.current) {
          clearInterval(stallTimer.current);
          stallTimer.current = null;
        }
        try {
          deactivateKeepAwake().catch(() => {});
        } catch {
          // best-effort
        }
        vTouch.current = null;
        if (cropTimer.current) {
          clearTimeout(cropTimer.current);
          cropTimer.current = null;
        }
        // Leave the camera where it is but stop any fling, and publish it so
        // the next tab opens on the same view.
        cancelAnimation(camS);
        cancelAnimation(camX);
        cancelAnimation(camY);
        publishCam();
      };
      // adoptSharedCam/publishCam/send/msg only touch refs and module state.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  function feedCursor(x, y) {
    if (typeof x !== "number" || typeof y !== "number") return;
    const p = curRef.current;
    if (p && Math.abs(p.x - x) < 0.004 && Math.abs(p.y - y) < 0.004) return;
    const n = { x, y };
    curRef.current = n;
    curX.value = x;
    curY.value = y;
    // The ring moves on the UI thread; React only needs to know it exists.
    if (!p) setCur(n);
  }

  // Crop messages only leave the phone when the region actually changed:
  // re-sending an identical crop re-encodes at a new size and looks like flicker.
  function sendCropIfChanged(c) {
    const l = lastSentCrop;
    if (l && Math.abs(l.x - c.x) < 0.001 && Math.abs(l.y - c.y) < 0.001 &&
        Math.abs(l.w - c.w) < 0.001 && Math.abs(l.h - c.h) < 0.001) {
      return;
    }
    lastSentCrop = { ...c };
    rememberCrop(c);
    send(msg.crop(c.x, c.y, c.w, c.h));
  }

  function setCrop(c) {
    setSel({ crop: { ...c } });
  }

  // ---- camera ------------------------------------------------------------

  // Monitor shape (w/h). A real monitor's size wins; All/Cam derive it from
  // the frames (frame px divided by the crop they cover).
  function monitorAspect() {
    const m = (monitors || []).find(
      (mm) => current !== "all" && current !== "cam" && String(mm.id) === String(current),
    );
    if (m && m.w && m.h) return m.w / m.h;
    return aspectRef.current || 0;
  }

  function setAspect(a) {
    if (!(a > 0) || Math.abs(a - aspectRef.current) < 0.002) return;
    aspectRef.current = a;
    aspectS.value = a;
  }

  useEffect(() => {
    const a = monitorAspect();
    if (a) setAspect(a);
    // monitorAspect reads monitors/current, which are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitors, current]);

  function geom() {
    const vw = viewSize.current.w || 0;
    const vh = viewSize.current.h || 0;
    const a = monitorAspect();
    if (!vw || !vh || !a) return null;
    return { vw, vh, fit: fitCanvas(vw, vh, a) };
  }

  function bumpTick(force) {
    if (force) {
      if (tickTimer.current) clearTimeout(tickTimer.current);
      tickTimer.current = null;
      setCamTick((t) => t + 1);
      return;
    }
    if (tickTimer.current) return;
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      setCamTick((t) => t + 1);
    }, 100);
  }

  // Ask the PC for the region around the view. Moving: roomy, rarely.
  // At rest: tight, so the picture is sharp. The picture never moves when
  // the new region arrives, because frames are placed by their own crop.
  function requestRegion(moving) {
    if (getSel().gameLock) return;
    const g = geom();
    if (!g) return;
    const vis = visibleRect(camRef.current, g.fit, g.vw, g.vh);
    const held = lastSentCrop || cropRef.current;
    if (moving) {
      if (regionCovers(held, vis, STRETCH_MOVING)) return;
      const now = Date.now();
      if (now - regionAt.current < 140) return;
      regionAt.current = now;
      const r = regionFor(vis, PAD_MOVING);
      setCrop(r);
      sendCropIfChanged(r);
      return;
    }
    if (regionCovers(held, vis, STRETCH_REST)) return;
    regionAt.current = Date.now();
    const r = regionFor(vis, PAD_REST);
    setCrop(r);
    sendCropIfChanged(r);
  }

  // Stable bridges for runOnJS: the gestures are built once per mode, while
  // the handlers they call are re-created on every render.
  const moveRef = useRef(null);
  const restRef = useRef(null);
  const jsMove = useRef((s, tx, ty) => moveRef.current?.(s, tx, ty)).current;
  const jsRest = useRef((s, tx, ty) => restRef.current?.(s, tx, ty)).current;
  moveRef.current = onCamMove;
  restRef.current = onCamRest;

  // UI thread -> JS: camera moved (throttled in the worklet).
  function onCamMove(s, tx, ty) {
    camRef.current = { s, tx, ty };
    bumpTick(false);
    requestRegion(true);
  }

  // UI thread -> JS: camera came to rest.
  function onCamRest(s, tx, ty) {
    camRef.current = { s, tx, ty };
    bumpTick(true);
    requestRegion(false);
    publishCam();
  }

  function publishCam() {
    const g = geom();
    if (!g) return;
    setSel({ cam: camToNorm(camRef.current, g.fit, g.vw, g.vh) });
  }

  function applyCamInstant(c) {
    cancelAnimation(camS);
    cancelAnimation(camX);
    cancelAnimation(camY);
    camS.value = c.s;
    camX.value = c.tx;
    camY.value = c.ty;
    camRef.current = { ...c };
    bumpTick(true);
  }

  function adoptSharedCam() {
    const g = geom();
    const n = getSel().cam;
    if (!g || !n) return;
    applyCamInstant(normToCam(n, g.fit, g.vw, g.vh));
  }

  // Animated camera move from JS (buttons, slider release).
  function animateCamTo(c) {
    const g = geom();
    if (!g) return;
    const t = clampCam(c, g.fit.bw, g.fit.bh, g.vw, g.vh);
    camRef.current = t;
    const cfg = { duration: ZOOM_MS };
    camX.value = withTiming(t.tx, cfg);
    camY.value = withTiming(t.ty, cfg);
    camS.value = withTiming(t.s, cfg, (fin) => {
      "worklet";
      if (fin) runOnJS(onCamRest)(t.s, t.tx, t.ty);
    });
    bumpTick(true);
  }

  // Zoom to an absolute level around the current view centre.
  function zoomTo(z) {
    const g = geom();
    if (!g) return;
    const n = camToNorm(camRef.current, g.fit, g.vw, g.vh);
    animateCamTo(camFor(z, n.cx, n.cy, g.fit, g.vw, g.vh));
  }

  function resetCrop() {
    animateCamTo({ s: 1, tx: 0, ty: 0 });
  }

  function onPick(id) {
    if (id !== "cam") resetCropSilent();
    pick(id);
  }

  function resetCropSilent() {
    applyCamInstant({ s: 1, tx: 0, ty: 0 });
    setSel({ cam: { z: 1, cx: 0.5, cy: 0.5 } });
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
    const c = cropRef.current;
    if (c.w < 0.995 || c.h < 0.995) sendCropIfChanged({ x: 0, y: 0, w: 1, h: 1 });
  }

  // Viewer-local point -> monitor point through the camera. Null when the
  // monitor shape or the layout is unknown: taps are ignored, never mis-fired.
  function mapToMonitor(x, y) {
    const g = geom();
    if (!g) return null;
    const m = viewToMonitor(x, y, camRef.current, g.fit, g.vw, g.vh);
    if (m.x < -0.01 || m.x > 1.01 || m.y < -0.01 || m.y > 1.01) return null;
    return { x: clamp01(m.x), y: clamp01(m.y) };
  }

  // ---- gestures (UI thread) ------------------------------------------------

  const lookOn = sub === "Look" && current !== "cam";
  const startS = useSharedValue({ s: 1, tx: 0, ty: 0, fx: 0, fy: 0 });
  const decayLeft = useSharedValue(0);

  const lookGesture = useMemo(() => {
    // Release: clamp scale, fling with the finger's velocity inside the edges
    // (rubber band at the rim), then report the resting camera to JS.
    function settle(vx, vy) {
      "worklet";
      const vw = vwS.value;
      const vh = vhS.value;
      const fit = fitCanvas(vw, vh, aspectS.value);
      const c = clampCam({ s: camS.value, tx: camX.value, ty: camY.value }, fit.bw, fit.bh, vw, vh);
      const { mx, my } = maxPan(c.s, fit.bw, fit.bh, vw, vh);
      const cfg = { duration: ZOOM_MS };
      if (Math.abs(c.s - camS.value) > 0.001) camS.value = withTiming(c.s, cfg);
      const inside = Math.abs(camX.value - c.tx) < 0.5 && Math.abs(camY.value - c.ty) < 0.5;
      const fast = Math.hypot(vx, vy) > 250;
      if (inside && fast && (mx > 0 || my > 0)) {
        // Two decays end at different times: report rest after the last one.
        decayLeft.value = 2;
        const done = () => {
          "worklet";
          decayLeft.value -= 1;
          if (decayLeft.value === 0) runOnJS(jsRest)(camS.value, camX.value, camY.value);
        };
        camX.value = withDecay({ velocity: mx > 0 ? vx : 0, clamp: [-mx, mx], rubberBandEffect: true, deceleration: 0.994 }, done);
        camY.value = withDecay({ velocity: my > 0 ? vy : 0, clamp: [-my, my], rubberBandEffect: true, deceleration: 0.994 }, done);
        return;
      }
      camX.value = withTiming(c.tx, cfg);
      camY.value = withTiming(c.ty, cfg, (fin) => {
        "worklet";
        if (fin) runOnJS(jsRest)(c.s, c.tx, c.ty);
      });
    }

    const pinchG = Gesture.Pinch()
      .enabled(lookOn)
      .onStart((e) => {
        cancelAnimation(camS);
        cancelAnimation(camX);
        cancelAnimation(camY);
        startS.value = { s: camS.value, tx: camX.value, ty: camY.value, fx: e.focalX, fy: e.focalY };
      })
      .onUpdate((e) => {
        const st = startS.value;
        const vw = vwS.value;
        const vh = vhS.value;
        const fit = fitCanvas(vw, vh, aspectS.value);
        const c = pinchCam(st, { x: st.fx, y: st.fy }, { x: e.focalX, y: e.focalY }, e.scale, vw, vh);
        const { mx, my } = maxPan(c.s, fit.bw, fit.bh, vw, vh);
        camS.value = c.s;
        camX.value = rubber(c.tx, mx, vw);
        camY.value = rubber(c.ty, my, vh);
        const now = Date.now();
        if (now - lastSyncS.value > 80) {
          lastSyncS.value = now;
          runOnJS(jsMove)(camS.value, camX.value, camY.value);
        }
      })
      .onEnd(() => {
        settle(0, 0);
      });

    const panG = Gesture.Pan()
      .enabled(lookOn)
      .maxPointers(1)
      .minDistance(2)
      .onStart(() => {
        cancelAnimation(camX);
        cancelAnimation(camY);
        startS.value = { s: camS.value, tx: camX.value, ty: camY.value, fx: 0, fy: 0 };
      })
      .onUpdate((e) => {
        const st = startS.value;
        const vw = vwS.value;
        const vh = vhS.value;
        const fit = fitCanvas(vw, vh, aspectS.value);
        const { mx, my } = maxPan(camS.value, fit.bw, fit.bh, vw, vh);
        camX.value = rubber(st.tx + e.translationX, mx, vw);
        camY.value = rubber(st.ty + e.translationY, my, vh);
        const now = Date.now();
        if (now - lastSyncS.value > 80) {
          lastSyncS.value = now;
          runOnJS(jsMove)(camS.value, camX.value, camY.value);
        }
      })
      .onEnd((e) => {
        settle(e.velocityX, e.velocityY);
      });

    const doubleTapG = Gesture.Tap()
      .enabled(lookOn)
      .numberOfTaps(2)
      .maxDuration(250)
      .maxDistance(24)
      .onEnd((e, ok) => {
        if (!ok) return;
        const vw = vwS.value;
        const vh = vhS.value;
        const fit = fitCanvas(vw, vh, aspectS.value);
        const cur = { s: camS.value, tx: camX.value, ty: camY.value };
        const target = cur.s < 1.6 ? zoomAt(cur, 2.5 / cur.s, { x: e.x, y: e.y }, vw, vh) : { s: 1, tx: 0, ty: 0 };
        const t = clampCam(target, fit.bw, fit.bh, vw, vh);
        const cfg = { duration: ZOOM_MS };
        camX.value = withTiming(t.tx, cfg);
        camY.value = withTiming(t.ty, cfg);
        camS.value = withTiming(t.s, cfg, (fin) => {
          if (fin) runOnJS(jsRest)(t.s, t.tx, t.ty);
        });
      });

    return Gesture.Simultaneous(pinchG, panG, doubleTapG);
    // Shared values and the JS bridges are stable; only the mode matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookOn]);

  // Canvas = whole monitor fitted into the view, moved by the camera.
  const canvasStyle = useAnimatedStyle(() => {
    const fit = fitCanvas(vwS.value, vhS.value, aspectS.value);
    return {
      position: "absolute",
      left: fit.ox,
      top: fit.oy,
      width: fit.bw,
      height: fit.bh,
      transform: [{ translateX: camX.value }, { translateY: camY.value }, { scale: camS.value }],
    };
  });

  // Cursor ring follows the camera on the UI thread (no re-render per frame).
  const ringStyle = useAnimatedStyle(() => {
    if (curX.value < 0 || vwS.value <= 0) return { opacity: 0 };
    const vw = vwS.value;
    const vh = vhS.value;
    const fit = fitCanvas(vw, vh, aspectS.value);
    const p = monitorToView(curX.value, curY.value, { s: camS.value, tx: camX.value, ty: camY.value }, fit, vw, vh);
    const vis = p.x >= -RING && p.x <= vw + RING && p.y >= -RING && p.y <= vh + RING;
    return { opacity: vis ? 1 : 0, transform: [{ translateX: p.x - RING / 2 }, { translateY: p.y - RING / 2 }] };
  });

  function viewerLocal(e) {
    const t = e.nativeEvent.touches?.[0] || e.nativeEvent;
    if (typeof t.locationX === "number") return { x: t.locationX, y: t.locationY };
    return { x: t.pageX || 0, y: t.pageY || 0 };
  }

  // ---- Click mode (raw touches; Look is owned by the gesture handler) -----

  function onViewerTouchStart(e) {
    if (current === "cam" || sub === "Look") return;
    const p = viewerLocal(e);
    // Double-tap detection for word select: a second quick tap near the last
    // one arms word-drag. Windows selects words on click, down+drag — which is
    // exactly first-tap click + this touch's down+move, so no extra message
    // type is needed. Triple-tap (third quick tap) = line select via 3 clicks.
    const now = Date.now();
    const lt = tapRef.current;
    const doubleTap = lt.t && now - lt.t < 300 && Math.hypot(p.x - lt.x, p.y - lt.y) < 20;
    vTouch.current = { x: p.x, y: p.y, t: now, moved: false, dragging: false, doubleTap: Boolean(doubleTap) };
  }

  function onViewerTouchMove(e) {
    if (current === "cam" || sub === "Look") return;
    const touches = e.nativeEvent.touches || [];
    if (touches.length === 2) {
      const t = touches[0];
      const last = lastRef.current;
      lastRef.current = { x: t.pageX, y: t.pageY };
      if (last) send(msg.scroll((t.pageX - last.x) * 1.5, -(t.pageY - last.y) * 1.5));
      return;
    }
    const st = vTouch.current;
    if (!st) return;
    const p = viewerLocal(e);
    // Text-selection precision: 5px threshold in Click mode (was 8px — small
    // text drags were misclassified as taps and the selection never started).
    // Hold-button drags own the button: direct viewer drags are ignored while
    // Hold is active so two drag sources never fight over one button.
    if (dragRef.current) return;
    const dist = Math.hypot(p.x - st.x, p.y - st.y);
    if (dist > 5) st.moved = true;
    if (st.moved && !st.dragging) {
      st.dragging = true;
      const m = mapToMonitor(st.x, st.y);
      if (!m) {
        st.dragging = false;
        st.moved = false;
        noteBlocked();
        return;
      }
      send(msg.drag("start", m.x, m.y, clickBtnRef.current));
    }
    if (st.dragging) {
      const m = mapToMonitor(p.x, p.y);
      if (!m) return;
      st.px = p.x;
      st.py = p.y;
      send(msg.drag("move", m.x, m.y, clickBtnRef.current));
    }
  }

  function onViewerTouchEnd(e) {
    if (current === "cam" || sub === "Look") {
      vTouch.current = null;
      return;
    }
    const st = vTouch.current;
    vTouch.current = null;
    lastRef.current = null;
    if (!st) return;
    // While Hold owns the button, viewer taps/drags are suppressed entirely
    // (otherwise a tap would fire an extra click mid-selection).
    if (dragRef.current) return;
    const touchesLeft = e.nativeEvent.touches?.length || 0;
    if (touchesLeft > 0) return;
    if (st.dragging) {
      // End at the RELEASE point (last move), not the start point — ending at
      // start collapsed text selections back to a caret.
      const ex = st.px ?? st.x;
      const ey = st.py ?? st.y;
      const m = mapToMonitor(ex, ey);
      if (m) send(msg.drag("end", m.x, m.y, clickBtnRef.current));
      try {
        onTapRef.current?.();
      } catch {
        // optional hook must not break gestures
      }
      return;
    }
    if (!st.moved && Date.now() - (st.t || 0) < 600) {
      const m = mapToMonitor(st.x, st.y);
      if (!m) {
        noteBlocked();
        return;
      }
      send(msg.abs(m.x, m.y, clickBtnRef.current));
      // Record for double/triple-tap: 2nd quick tap = word select
      // (double-click), 3rd = line select. A 2nd tap that moves becomes a
      // word-drag via the doubleTap flag set at touch start.
      tapRef.current = { t: Date.now(), x: st.x, y: st.y };
      try {
        onTapRef.current?.();
      } catch {
        // optional hook must not break gestures
      }
    }
  }

  function onTouchStart(e) {
    const t = e.nativeEvent.touches[0];
    lastRef.current = { x: t.pageX, y: t.pageY };
  }

  function onTouchMove(e) {
    const touches = e.nativeEvent.touches;
    const t = touches[0];
    const last = lastRef.current;
    if (!last) {
      lastRef.current = { x: t.pageX, y: t.pageY };
      return;
    }
    const dx = (t.pageX - last.x) * 1.5;
    const dy = (t.pageY - last.y) * 1.5;
    lastRef.current = { x: t.pageX, y: t.pageY };
    if (touches.length === 2) {
      send(msg.scroll(dx, -dy));
      return;
    }
    send(msg.move(dx, dy));
  }

  function onTouchEnd() {
    lastRef.current = null;
  }

  function holdLeft() {
    // Hold follows the selected Click button (L/R/M) so right-hold drags work.
    const btn = clickBtnRef.current || "left";
    dragRef.current = btn;
    send(msg.click(btn, true, false));
  }

  function releaseLeft() {
    const btn = dragRef.current || clickBtnRef.current || "left";
    if (dragRef.current) {
      dragRef.current = false;
      send(msg.click(btn, false, true));
    }
  }

  function releaseHoldSilent() {
    // Best-effort UP so the PC never thinks a button is stuck DOWN after
    // tab blur / unmount / reconnect / click-button switch.
    const btn = dragRef.current;
    if (btn) {
      dragRef.current = false;
      try {
        send(msg.click(btn, false, true));
      } catch {
        // teardown is best-effort
      }
    }
  }

  function onBarStart(e) {
    const t = e.nativeEvent.touches?.[0];
    barDrag.current = { y: t ? t.pageY : 0 };
  }

  function onBarMove(e) {
    const st = barDrag.current;
    if (!st) return;
    const t = e.nativeEvent.touches?.[0];
    if (!t) return;
    const dy = t.pageY - st.y;
    st.y = t.pageY;
    if (dy) send(msg.scroll(0, Math.round(-dy * 5)));
  }

  function onBarEnd() {
    barDrag.current = null;
  }

  // Slider drag: absolute zoom around the view centre, live; rest on release.
  function onSliderTouch(e) {
    const t = e.nativeEvent.touches?.[0];
    if (!t || typeof t.locationY !== "number") return;
    const g = geom();
    if (!g) return;
    const h = trackHRef.current || 1;
    const f = Math.max(0, Math.min(1, t.locationY / h));
    const z = 1 + (1 - f) * (MAX_ZOOM - 1);
    const n = camToNorm(camRef.current, g.fit, g.vw, g.vh);
    applyCamInstant(camFor(z, n.cx, n.cy, g.fit, g.vw, g.vh));
    requestRegion(true);
  }

  function onSliderEnd() {
    const c = camRef.current;
    onCamRest(c.s, c.tx, c.ty);
  }

  function onFrame(f) {
    // Dropped frames still carry fresh cursor/size metadata, but they were
    // NOT displayed: skip the byte meters so "real fps" means displayed
    // frames (honest).
    if (f?.w && f?.h) {
      frameSize.current = { w: f.w, h: f.h };
      // All / Cam have no single monitor size: derive the shape from frames.
      const real = (monitors || []).some(
        (mm) => current !== "all" && current !== "cam" && String(mm.id) === String(current) && mm.w && mm.h,
      );
      if (!real) {
        const c = snapCrop(f.crop);
        setAspect(f.w / Math.max(0.001, c.w) / (f.h / Math.max(0.001, c.h)));
      }
    }
    if (typeof f?.cx === "number") feedCursor(f.cx, f.cy);
    lastFrameAt.current = Date.now();
    if (stalled) setStalled(false);
    if (f?._dropped) return;
    trackFrameBytes(f?.jpeg?.length);
  }

  // Stream settings popover (preset / Q / fps): opened from the gear or the
  // fps pill, closes on outside tap or after a few idle seconds.
  const [streamOpen, setStreamOpen] = useState(false);
  const streamTimer = useRef(null);
  const armStreamTimer = useCallback(() => {
    if (streamTimer.current) clearTimeout(streamTimer.current);
    streamTimer.current = setTimeout(() => setStreamOpen(false), 6000);
  }, []);
  useEffect(() => {
    if (streamOpen) armStreamTimer();
    else if (streamTimer.current) clearTimeout(streamTimer.current);
    return () => streamTimer.current && clearTimeout(streamTimer.current);
  }, [streamOpen, armStreamTimer]);

  // Gesture hint: shown as a small overlay for a few seconds after the mode
  // or click button changes, instead of a text line that pushed the viewer.
  const hintText =
    sub === "Look"
      ? "Geser = pan · pinch = zoom · 2x tap = zoom"
      : clickBtn === "right"
        ? "Tap = klik kanan · drag = drag kanan"
        : clickBtn === "middle"
          ? "Tap = klik tengah · drag = drag tengah"
          : "Tap = klik · 2x tap = kata · drag = pilih";
  const [hintOn, setHintOn] = useState(true);
  useEffect(() => {
    setHintOn(true);
    const t = setTimeout(() => setHintOn(false), 3500);
    return () => clearTimeout(t);
  }, [sub, clickBtn]);
  // Minimap / badge / slider read the JS camera mirror (~10 Hz while moving).
  const g0 = geom();
  const vis = g0 ? visibleRect(camRef.current, g0.fit, g0.vw, g0.vh) : { x: 0, y: 0, w: 1, h: 1 };
  const effZoom = camRef.current.s || 1;
  const sliderFrac = Math.max(0, Math.min(1, (effZoom - 1) / (MAX_ZOOM - 1)));

  // The camera stays where it is across Click/Look: zoom in with Look, then
  // switch to Click and tap precisely on the zoomed picture.
  function changeSub(s) {
    setSel({ mode: s });
  }

  return (
    <View style={styles.root}>
      <View style={styles.topRow}>
        {!!title && <Text style={styles.title}>{title}</Text>}
        <ConnDot />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.topScroll} contentContainerStyle={styles.topScrollContent}>
        <MonitorChips monitors={monitors} current={current} onPick={onPick} row />
        <View style={styles.modes}>
          {["Click", "Look"].map((s) => (
            <Pressable key={s} onPress={() => changeSub(s)} style={[styles.subTab, sub === s && styles.subTabActive]}>
              <Text style={[styles.subText, sub === s && styles.subTextActive]}>{s}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setSel({ bar: !bar })} style={[styles.subTab, bar && styles.subTabActive]}>
            <Text style={[styles.subText, bar && styles.subTextActive]}>Bar</Text>
          </Pressable>
        </View>
        </ScrollView>
        <Pressable
          onPress={() => setStreamOpen((v) => !v)}
          style={[styles.gear, streamOpen && styles.subTabActive]}
          hitSlop={6}
          accessibilityLabel="Pengaturan stream"
        >
          <Text style={[styles.gearText, streamOpen && styles.subTextActive]}>⚙</Text>
        </Pressable>
      </View>
      <View style={styles.viewerBox}>
        <GestureDetector gesture={lookGesture}>
        <View
          ref={wrapRef}
          style={styles.viewerWrap}
          collapsable={false}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            const prev = viewSize.current;
            viewSize.current = { w: width, h: height };
            vwS.value = width;
            vhS.value = height;
            measureOrigin();
            // Keep the same monitor point centred when the view resizes
            // (soft keyboard, rotation), clamped to the new edges.
            const a = monitorAspect();
            if (a && prev.w && prev.h && (prev.w !== width || prev.h !== height)) {
              const n = camToNorm(camRef.current, fitCanvas(prev.w, prev.h, a), prev.w, prev.h);
              applyCamInstant(normToCam(n, fitCanvas(width, height, a), width, height));
            } else if (!prev.w) {
              adoptSharedCam();
            }
            bumpTick(true);
          }}
          onTouchStart={onViewerTouchStart}
          onTouchMove={onViewerTouchMove}
          onTouchEnd={onViewerTouchEnd}
        >
          {/* Camera canvas: whole monitor, frames placed at their own crop. */}
          <Reanimated.View style={canvasStyle} pointerEvents="none">
            <ScreenView style={styles.canvasFill} onFrame={onFrame} monKey={current} placed resolveCrop={snapCrop} />
          </Reanimated.View>
          {!!cur && <Reanimated.View pointerEvents="none" style={[styles.ring, ringStyle]} />}
        </View>
        </GestureDetector>
        {/* Look controls sit beside (not inside) the gesture view so a drag on
            the slider or a tap on a button never pans the camera. */}
          {sub === "Look" && (
            <View style={styles.zoomSlider} pointerEvents="box-none">
              <View
                style={styles.zTrack}
                onLayout={(e) => {
                  const h = Math.round(e.nativeEvent.layout.height);
                  if (h && h !== trackHRef.current) {
                    trackHRef.current = h;
                    setTrackH(h);
                  }
                }}
                onTouchStart={onSliderTouch}
                onTouchMove={onSliderTouch}
                onTouchEnd={onSliderEnd}
              >
                <View
                  pointerEvents="none"
                  style={[styles.zKnob, { top: (1 - sliderFrac) * Math.max(0, (trackH || 120) - 26) }]}
                />
              </View>
            </View>
          )}
          {sub === "Look" && (
            <View style={styles.lookBar} pointerEvents="box-none">
              <View style={styles.zoomRow} pointerEvents="none">
                <View style={styles.zoomBadge}>
                  <Text style={styles.zoomBadgeText}>ZOOM {effZoom.toFixed(1)}x</Text>
                </View>
              </View>
              <View style={styles.lookBottom} pointerEvents="box-none">
                <View style={styles.minimap} pointerEvents="none">
                  <View
                    style={[
                      styles.viewport,
                      {
                        left: `${(vis.x * 100).toFixed(1)}%`,
                        top: `${(vis.y * 100).toFixed(1)}%`,
                        width: `${(vis.w * 100).toFixed(1)}%`,
                        height: `${(vis.h * 100).toFixed(1)}%`,
                      },
                    ]}
                  />
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.zoomRowScroll}>
                  <View style={styles.zoomRow}>
                    <Pressable onPress={resetCrop} style={styles.zoomBtn}><Text style={styles.zoomText}>Fit</Text></Pressable>
                    <Pressable onPress={() => zoomTo(2)} style={styles.zoomBtn}><Text style={styles.zoomText}>2x</Text></Pressable>
                    <Pressable onPress={() => zoomTo(4)} style={styles.zoomBtn}><Text style={styles.zoomText}>4x</Text></Pressable>
                    <Pressable onPress={() => zoomTo(effZoom * 1.25)} style={styles.zoomBtn}><Text style={styles.zoomText}>+</Text></Pressable>
                    <Pressable onPress={() => zoomTo(effZoom / 1.25)} style={styles.zoomBtn}><Text style={styles.zoomText}>−</Text></Pressable>
                  </View>
                </ScrollView>
              </View>
            </View>
          )}
        <View style={[styles.overlayTop, bar && styles.shiftForBar]} pointerEvents="none">
          {hintOn && sub === "Click" && !streamOpen && (
            <View style={styles.hintPill}>
              <Text style={styles.hint}>{hintText}</Text>
            </View>
          )}
          {stalled && (
            <View style={styles.stalled}>
              <Text style={styles.stalledText}>Stream terhenti — mencoba lagi otomatis…</Text>
            </View>
          )}
          {tapBlocked && !stalled && (
            <View style={styles.blocked}>
              <Text style={styles.blockedText}>Menunggu info layar, coba lagi sebentar…</Text>
            </View>
          )}
          {!!(current === "cam" && camError) && (
            <View style={styles.stalled}>
              <Text style={styles.stalledText}>{camError}</Text>
            </View>
          )}
        </View>
        {sub === "Click" && (
          <View style={[styles.clickSeg, bar && styles.shiftForBar]}>
            {CLICK_BTNS.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => setSel({ clickBtn: b.id })}
                hitSlop={4}
                style={[styles.clickSegBtn, clickBtn === b.id && styles.clickBtnActive]}
              >
                <Text style={[styles.clickText, clickBtn === b.id && styles.clickTextActive]}>{b.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {!streamOpen && (
          <Pressable onPress={() => setStreamOpen(true)} style={styles.fpsPill} hitSlop={4} accessibilityLabel="Buka pengaturan stream">
            <StreamStats />
          </Pressable>
        )}
        {streamOpen && (
          <>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setStreamOpen(false)} accessibilityLabel="Tutup pengaturan stream" />
            <View style={styles.streamPop} onTouchStart={armStreamTimer}>
              <StreamControls compact />
            </View>
          </>
        )}
        {bar && (
          <View style={styles.bar}>
            <Pressable onPress={() => send(msg.scroll(0, 240))} style={styles.barBtn}>
              <Text style={styles.barText}>▲</Text>
            </Pressable>
            <View style={styles.barTrack} onTouchStart={onBarStart} onTouchMove={onBarMove} onTouchEnd={onBarEnd}>
              <View style={styles.barThumb} />
            </View>
            <Pressable onPress={() => send(msg.scroll(0, -240))} style={styles.barBtn}>
              <Text style={styles.barText}>▼</Text>
            </Pressable>
          </View>
        )}
      </View>
      <View style={styles.controls}>
      {actions && (
        <View style={styles.btnRow}>
          <Pressable onPress={() => send(msg.click("left", true, true))} style={styles.btn}>
            <Text style={styles.btnText}>Left</Text>
          </Pressable>
          <Pressable onPressIn={holdLeft} onPressOut={releaseLeft} style={styles.btn}>
            <Text style={styles.btnText}>
              {clickBtn === "right" ? "Hold R" : clickBtn === "middle" ? "Hold M" : "Hold"}
            </Text>
          </Pressable>
          <Pressable onPress={() => send(msg.click("middle", true, true))} style={styles.btn}>
            <Text style={styles.btnText}>Mid</Text>
          </Pressable>
          <Pressable onPress={() => send(msg.click("right", true, true))} style={styles.btn}>
            <Text style={styles.btnText}>Right</Text>
          </Pressable>
        </View>
      )}
      {touchpad && (
        <View style={styles.pad} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <Text style={styles.padText}>
            {clickBtn === "right"
              ? "slide = move · 2 fingers = scroll · hold R to drag"
              : clickBtn === "middle"
                ? "slide = move · 2 fingers = scroll · hold M to drag"
                : "slide = move · 2 fingers = scroll · hold Left to drag"}
          </Text>
        </View>
      )}
      {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 8 },
  title: { color: COLORS.text, fontSize: 15, fontWeight: "800" },
  topScroll: { flex: 1 },
  topScrollContent: { flexDirection: "row", alignItems: "center", gap: 4 },
  gear: { backgroundColor: COLORS.chip, borderRadius: 999, width: 30, height: 28, alignItems: "center", justifyContent: "center" },
  gearText: { color: COLORS.muted, fontSize: 15, fontWeight: "800" },
  fpsPill: { position: "absolute", top: 6, right: 6, maxWidth: "75%", backgroundColor: "rgba(15,23,42,0.8)", borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8 },
  streamPop: { position: "absolute", top: 4, left: 0, right: 0 },
  clickSeg: { position: "absolute", left: 6, bottom: 6, flexDirection: "row", gap: 4, backgroundColor: "rgba(15,23,42,0.7)", borderRadius: 999, padding: 3 },
  clickSegBtn: { width: 34, height: 26, borderRadius: 999, backgroundColor: "rgba(30,41,59,0.9)", alignItems: "center", justifyContent: "center" },
  shiftForBar: { left: 46 },
  controls: { height: CONTROL_H, paddingHorizontal: 8, paddingBottom: CONTROL_PAD, gap: CONTROL_GAP, overflow: "hidden" },
  modes: { flexDirection: "row", alignItems: "center", gap: 4 },
  subTab: { backgroundColor: COLORS.chip, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10 },
  subTabActive: { backgroundColor: "#0c4a6e" },
  subText: { color: COLORS.muted, fontWeight: "700" },
  subTextActive: { color: COLORS.text },
  hint: { color: "#e2e8f0", fontSize: 11, fontWeight: "700" },
  hintPill: { alignSelf: "flex-start", backgroundColor: "rgba(15,23,42,0.8)", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  overlayTop: { position: "absolute", left: 6, right: 6, top: 32, gap: 4 },
  stalled: { backgroundColor: "rgba(127,29,29,0.9)", borderRadius: 8, padding: 8 },
  stalledText: { color: "#e8eefc", fontSize: 12, fontWeight: "700", textAlign: "center" },
  blocked: { backgroundColor: "rgba(30,41,59,0.9)", borderRadius: 8, padding: 6 },
  blockedText: { color: COLORS.muted, fontSize: 11, fontWeight: "700", textAlign: "center" },
  clickBtn: { flex: 1, backgroundColor: COLORS.chip, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  clickBtnActive: { backgroundColor: "#38bdf8" },
  clickText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  clickTextActive: { color: "#0b1220" },
  viewerBox: { flex: 1, minHeight: 160, marginHorizontal: 8, marginBottom: 6, position: "relative" },
  viewerWrap: { flex: 1, borderRadius: 12, overflow: "hidden", backgroundColor: "#000" },
  canvasFill: { width: "100%", height: "100%" },
  ring: {
    position: "absolute",
    left: 0,
    top: 0,
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2,
    borderColor: "#38bdf8",
    backgroundColor: "transparent",
  },
  lookBar: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 6, gap: 6 },
  zoomSlider: { position: "absolute", right: 4, top: 56, bottom: 118, width: 36, alignItems: "center" },
  zTrack: { flex: 1, width: 10, borderRadius: 5, backgroundColor: "rgba(30,41,59,0.7)" },
  zKnob: { position: "absolute", left: -8, width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(250,204,21,0.9)" },
  zoomRow: { flexDirection: "row", gap: 6, justifyContent: "center" },
  lookBottom: { flexDirection: "row", gap: 6, alignItems: "flex-end" },
  zoomRowScroll: { flexGrow: 1, alignItems: "center" },
  zoomBadge: { backgroundColor: "rgba(124,45,18,0.9)", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 12 },
  zoomBadgeText: { color: "#fed7aa", fontWeight: "800", fontSize: 12 },
  zoomBtn: { backgroundColor: "rgba(30,41,59,0.85)", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 9 },
  zoomText: { color: COLORS.text, fontWeight: "800", fontSize: 11 },
  minimap: { width: 96, height: 60, backgroundColor: "rgba(15,23,42,0.85)", borderRadius: 6, borderWidth: 1, borderColor: "#334155", overflow: "hidden" },
  viewport: { position: "absolute", borderWidth: 2, borderColor: "#38bdf8", backgroundColor: "rgba(56,189,248,0.15)" },
  bar: { position: "absolute", left: 0, top: 0, bottom: 0, width: 40, paddingVertical: 8, alignItems: "center", justifyContent: "space-between" },
  barBtn: { backgroundColor: "rgba(30,41,59,0.85)", borderRadius: 8, width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  barText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  barTrack: { flex: 1, width: 14, marginVertical: 6, borderRadius: 7, backgroundColor: "rgba(30,41,59,0.6)", alignItems: "center", justifyContent: "center" },
  barThumb: { width: 14, height: 44, borderRadius: 7, backgroundColor: "rgba(125,211,252,0.7)" },
  error: { color: COLORS.danger, paddingHorizontal: 8, textAlign: "center", fontSize: 12 },
  btnRow: { flexDirection: "row", gap: 6, height: 34 },
  btn: { flex: 1, backgroundColor: COLORS.chip, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnText: { color: COLORS.text, fontWeight: "700" },
  pad: { flex: 1, borderRadius: 14, backgroundColor: COLORS.card, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  padText: { color: COLORS.muted, textAlign: "center", fontSize: 12 },
});
