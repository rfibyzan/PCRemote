/** Universal viewer panel: Click / Look / Bar + screen + zoom + source chips.
 * Used by PAD, TYPE and WIN so the mode behavior is identical everywhere.
 * CLICK: L/R/M selector sets the tap+drag button, tap = abs click, drag = drag.
 * LOOK: drag to pan, pinch to zoom (EXACT commit, no aspect relock), Fit/1x/2x/4x
 * are the only intentional aspect-locked zooms. BAR: scrollbar overlay.
 * Cross-tab: transient pinch transform is per-tab but resynced on focus so the
 * pointer never desyncs after zoom + tab switch. Stalled streams auto-resubscribe.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { COLORS, MonitorChips, ScreenView } from "./components";
import { ConnDot, StreamControls, StreamStats, effectiveFpsValue, getQuality, getSel, setSel, useMonitorSource, useSel } from "./controls";
import { CursorDot, cursorPixels, trackFrameBytes } from "./cursor";
import { msg } from "./protocol";
import { addListener, getStatus, send } from "./connection";
import { CONTROL_H, CONTROL_GAP } from "./tablayout";
import { MIN_CROP, clampCrop, clampLiveScale, cropMatches, pinchStep, sliderFractionToZoom } from "./zoom";

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

export function getCommittedCrop() {
  return lastSentCrop ? { ...lastSentCrop } : null;
}

// GAME bypasses ViewerPanel (it sends msg.crop directly), so it must keep
// this in sync or post-exit commits will be skipped/duplicated as stale.
export function setCommittedCrop(c) {
  lastSentCrop = c ? { ...c } : null;
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
  const animTimer = useRef(null);
  const lastRef = useRef(null);
  const dragRef = useRef(false);
  const vTouch = useRef(null);
  const pinch = useRef(null);
  const barDrag = useRef(null);
  // Last completed tap (for double/triple-tap word/line select).
  const tapRef = useRef({ t: 0, x: 0, y: 0 });
  // Zoom slider (Look, right edge): absolute 1x..MAX_ZOOM, center-anchored.
  const [trackH, setTrackH] = useState(0);
  const trackHRef = useRef(0);
  // LOCAL transform zoom (UI thread, 60fps): transient feedback during an
  // active pinch. Committed to the remote crop on release; the transform
  // then settles back to identity as sharper crop frames arrive. No black
  // flash: the last valid frame is always kept underneath.
  const scaleV = useRef(new Animated.Value(1)).current;
  const panV = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const settleAnim = useRef(null);
  const liveRef = useRef({ s: 1, tx: 0, ty: 0 });
  // Mirror state exists only to re-render minimap/badge/dot at ~10 Hz while
  // the Animated values drive pixels at 60fps without re-renders.
  const [, setLive] = useState({ s: 1, tx: 0, ty: 0 });
  const liveTimer = useRef(null);
  const rebaseTimer = useRef(null);
  // Counts received frames: rebase waits for a NEW frame, never a bare timer.
  const frameTick = useRef(0);
  // Crop carried in the header of the last DISPLAYED frame. Rebase waits for
  // a frame encoded with the committed crop, not just any new frame: frames
  // already in flight still show the old region and caused a visible jump.
  const lastFrameCrop = useRef(null);
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
  // Touch telemetry (temporary diagnosis): throttled Metro logs, no behavior.
  const teleLast = useRef(0);
  function tele(msg) {
    const now = Date.now();
    if (now - teleLast.current < 500) return;
    teleLast.current = now;
    console.log(`[touch] ${msg}`);
  }
  function touchKeys(t) {
    if (!t) return "none";
    const keys = [];
    if (typeof t.locationX === "number") keys.push(`loc=${t.locationX},${t.locationY}`);
    if (typeof t.pageX === "number") keys.push(`page=${t.pageX},${t.pageY}`);
    return keys.join(" ") || "NO-COORDS";
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
      if (animTimer.current) clearInterval(animTimer.current);
      if (liveTimer.current) clearTimeout(liveTimer.current);
      if (rebaseTimer.current) clearTimeout(rebaseTimer.current);
      if (stallTimer.current) clearInterval(stallTimer.current);
      if (tapBlockedTimer.current) clearTimeout(tapBlockedTimer.current);
      stopSettle();
      cropTimer.current = animTimer.current = liveTimer.current = rebaseTimer.current = null;
      pinch.current = null;
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
        pinch.current = null;
      }
    });
  }, []);

  // Cross-tab resync: transient live transform is per-tab, committed crop is
  // shared. On focus, drop any stale live (which belonged to another tab's
  // crop), cancel in-flight gestures, and re-assert the shared crop so agent
  // and client agree. This is what previously required manual Fit.
  useFocusEffect(
    useCallback(() => {
      const gen = ++focusGen.current;
      resetTransformInstant();
      pinch.current = null;
      vTouch.current = null;
      dimsWarned.current = false;
      // Re-assert shared crop idempotently (agent dedups identical crop).
      // Skipped while GAME owns the crop — its Fit/restore transaction is
      // authoritative and a background panel must not fight it.
      try {
        if (!getSel().gameLock) {
          const c = cropRef.current;
          if (c && (c.w < 0.995 || c.h < 0.995 || c.x > 0.004 || c.y > 0.004)) {
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
          // If pong is also gone the socket layer (not us) owns the reconnect.
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
        // Blur: cancel gesture + transient so returning never sees stale live.
        pinch.current = null;
        vTouch.current = null;
        if (cropTimer.current) {
          clearTimeout(cropTimer.current);
          cropTimer.current = null;
        }
        if (animTimer.current) {
          clearInterval(animTimer.current);
          animTimer.current = null;
        }
        stopSettle();
        resetTransformInstant();
      };
      // resetTransformInstant/send/msg are intentionally stable (refs/module).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  function feedCursor(x, y) {
    if (typeof x !== "number" || typeof y !== "number") return;
    const p = curRef.current;
    if (p && Math.abs(p.x - x) < 0.004 && Math.abs(p.y - y) < 0.004) return;
    const n = { x, y };
    curRef.current = n;
    setCur(n);
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
    send(msg.crop(c.x, c.y, c.w, c.h));
  }

  function setCrop(c) {
    setSel({ crop: { ...c } });
  }

  function setCropThrottled(next, immediate) {
    const c = clampCrop(next);
    setCrop(c);
    if (immediate) {
      if (cropTimer.current) clearTimeout(cropTimer.current);
      cropTimer.current = null;
      sendCropIfChanged(c);
      return;
    }
    if (cropTimer.current) return;
    cropTimer.current = setTimeout(() => {
      cropTimer.current = null;
      sendCropIfChanged({ ...cropRef.current });
    }, 180);
  }

  function resetCrop() {
    resetTransformInstant();
    if (animTimer.current) {
      clearInterval(animTimer.current);
      animTimer.current = null;
    }
    setCropThrottled({ x: 0, y: 0, w: 1, h: 1 }, true);
  }

  // Zoom target locked to the viewer aspect so the encoded region fills the
  // view with no black bars. cx/cy = monitor-norm center to keep.
  function aspectCrop(w, cx, cy) {
    const v = viewSize.current;
    const d = monitorDims();
    if (!d) return null; // dims unknown (before hello/layout): never crash
    const { fw, fh } = d;
    const viewA = (v.w || 1) / Math.max(1, v.h);
    let nw = Math.max(MIN_CROP, Math.min(1, w));
    let nh = (nw * fw) / (fh * viewA);
    if (nh > 1) {
      nh = 1;
      nw = (nh * fh * viewA) / fw;
    }
    nh = Math.max(MIN_CROP, Math.min(1, nh));
    return clampCrop({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh });
  }

  function zoomToWidth(w) {
    const c = cropRef.current;
    const target = aspectCrop(w, c.x + c.w / 2, c.y + c.h / 2);
    if (!target) return;
    resetTransformInstant();
    zoomAnimated(target);
  }

  // Smooth stepped zoom (~120 ms) instead of a discrete jump.
  function zoomAnimated(to) {
    const from = { ...cropRef.current };
    if (animTimer.current) {
      clearInterval(animTimer.current);
      animTimer.current = null;
    }
    const steps = 6;
    let i = 0;
    animTimer.current = setInterval(() => {
      i += 1;
      const t = Math.min(1, i / steps);
      const c = clampCrop({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        w: from.w + (to.w - from.w) * t,
        h: from.h + (to.h - from.h) * t,
      });
      setCrop(c);
      if (t >= 1) {
        clearInterval(animTimer.current);
        animTimer.current = null;
        setCropThrottled(to, true);
      }
    }, 20);
  }

  function onPick(id) {
    if (id !== "cam") resetCropSilent();
    pick(id);
  }

  function resetCropSilent() {
    resetTransformInstant();
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
    const c = cropRef.current;
    if (c.w < 0.995 || c.h < 0.995) sendCropIfChanged({ x: 0, y: 0, w: 1, h: 1 });
  }

  // Mirror the live transform into state (throttled) for minimap / badge /
  // cursor-dot. The Animated values themselves drive pixels at 60fps.
  function syncLive(force) {
    if (!force) {
      if (liveTimer.current) return;
      liveTimer.current = setTimeout(() => {
        liveTimer.current = null;
        setLive({ ...liveRef.current });
      }, 100);
      return;
    }
    if (liveTimer.current) {
      clearTimeout(liveTimer.current);
      liveTimer.current = null;
    }
    setLive({ ...liveRef.current });
  }

  function stopSettle() {
    if (settleAnim.current) {
      settleAnim.current.stop();
      settleAnim.current = null;
    }
    if (rebaseTimer.current) {
      clearTimeout(rebaseTimer.current);
      rebaseTimer.current = null;
    }
  }

  function resetTransformInstant() {
    stopSettle();
    liveRef.current = { s: 1, tx: 0, ty: 0 };
    scaleV.setValue(1);
    panV.setValue({ x: 0, y: 0 });
    syncLive(true);
  }

  // Guarded rebase for the PERSISTENT transform model: after a crop follow
  // is sent, drop back to identity once its sharper frames have had time to
  // arrive (content matches, so the cut is invisible). Cancelled by any new
  // gesture — fingers never wait for frames, so zoom feels realtime at any
  // stream fps. Timing scales with the EFFECTIVE stream fps (remote/cropped
  // aware), not the raw user target.
  function scheduleRebase() {
    stopSettle();
    let delay = 350;
    try {
      const q = getQuality();
      const c = cropRef.current;
      const cropped = Boolean(c && (c.w < 0.995 || c.h < 0.995));
      const remote = String(getStatus().link || "") === "remote";
      const fps = effectiveFpsValue(q.q, q.fpsStep, { remote, cropped });
      delay = Math.max(200, Math.min(600, Math.round(1000 / Math.max(1, fps)) + 150));
    } catch {
      // fall back to the default delay
    }
    const snap = { ...liveRef.current };
    const tick0 = frameTick.current;
    const t0 = Date.now();
    const check = () => {
      rebaseTimer.current = null;
      const L = liveRef.current;
      if (
        Math.abs(L.s - snap.s) > 0.001 ||
        Math.abs(L.tx - snap.tx) > 1 ||
        Math.abs(L.ty - snap.ty) > 1
      ) {
        return; // fingers moved on — the gesture owns the transform now
      }
      // Rebase only once a NEW frame encoded with the COMMITTED crop has
      // arrived (or 800ms passed with a stalled stream, so we never get
      // stuck transformed). Old-crop frames still in flight are skipped.
      const fresh = frameTick.current !== tick0 && cropMatches(lastFrameCrop.current, cropRef.current);
      if (!fresh && Date.now() - t0 < 800) {
        rebaseTimer.current = setTimeout(check, 50);
        return;
      }
      liveRef.current = { s: 1, tx: 0, ty: 0 };
      scaleV.setValue(1);
      panV.setValue({ x: 0, y: 0 });
      syncLive(true);
    };
    rebaseTimer.current = setTimeout(check, delay);
  }

  // Region pixel dims from TRUE monitor size only. Returns null when the
  // monitor is unknown or the view isn't laid out yet — callers must NOT
  // silently fall back to stale frame dims (that was the cross-tab pointer
  // desync: new tab mapped taps with zeros until first frame arrived).
  // Fit (w=1,h=1) masked the bug, which is why users had to Fit first.
  const dimsWarned = useRef(false);
  function monitorDims() {
    const c = cropRef.current;
    const m = (monitors || []).find(
      (mm) => current !== "all" && current !== "cam" && String(mm.id) === String(current),
    );
    if (m && m.w && m.h) {
      return { fw: Math.max(1, c.w * m.w), fh: Math.max(1, c.h * m.h), exact: true };
    }
    // All/Cam legitimately use frame dims (no single monitor size).
    if (current === "all" || current === "cam") {
      const f = frameSize.current;
      if (f.w && f.h) return { fw: f.w, fh: f.h, exact: true };
      return null;
    }
    if (!dimsWarned.current) {
      dimsWarned.current = true;
      console.log(`[pointer] no true monitor dims for current=${String(current)} — tap ignored until hello/layout`);
    }
    return null;
  }

  // Viewer-local point -> UNCLAMPED fractions of the displayed image.
  // Returns null when dims unknown so taps are ignored, never mis-mapped.
  function localToFrac(lx, ly) {
    const d = monitorDims();
    if (!d) return null;
    const vw = viewSize.current.w || 0;
    const vh = viewSize.current.h || 0;
    if (!vw || !vh) return null;
    const { fw, fh } = d;
    const scale = Math.min(vw / Math.max(1, fw), vh / Math.max(1, fh));
    const dispW = Math.max(1, fw * scale);
    const dispH = Math.max(1, fh * scale);
    const offX = (vw - dispW) / 2;
    const offY = (vh - dispH) / 2;
    return { nx: (lx - offX) / dispW, ny: (ly - offY) / dispH, dispW, dispH };
  }

  function mapToMonitor(tx, ty, cr) {
    // Invert the live transform first: taps land on displayed content,
    // which may be zoomed/panned independently of the committed crop.
    // Returns null when dims unknown: caller must ignore, never mis-fire.
    const L = liveRef.current;
    const vw = viewSize.current.w || 0;
    const vh = viewSize.current.h || 0;
    if (!vw || !vh) return null;
    const cx = vw / 2;
    const cy = vh / 2;
    const ux = cx + (tx - cx - L.tx) / Math.max(0.01, L.s);
    const uy = cy + (ty - cy - L.ty) / Math.max(0.01, L.s);
    const fr = localToFrac(ux, uy);
    if (!fr) return null;
    const { nx, ny } = fr;
    const c = cr || cropRef.current;
    return { x: clamp01(c.x + clamp01(nx) * c.w), y: clamp01(c.y + clamp01(ny) * c.h) };
  }

  // Average viewer-local touch point (locationX/Y are viewer-relative on the
  // bare image area); null when unavailable -> gestures fall back to center.
  function avgLocal(touches) {
    let sx = 0;
    let sy = 0;
    for (const t of touches) {
      if (typeof t.locationX !== "number" || typeof t.locationY !== "number") return null;
      sx += t.locationX;
      sy += t.locationY;
    }
    return { x: sx / touches.length, y: sy / touches.length };
  }

  // NOTE (relock audit): pinch/slider commits are EXACT — fingers leave R,
  // we commit clampCrop(R). No normalizeAspect here (deleted): relock rewrote
  // R into R' and the rebase visibly jumped, plus per-tab viewSize made the
  // same zoom commit different crops per tab. Explicit Fit/1x/2x/4x buttons
  // remain aspect-locked via aspectCrop/zoomToWidth (intentional).

  // Visible monitor rect = committed crop composed with the live transient
  // transform. Drives the minimap, ZOOM badge and pinch commit.
  // Returns null when dims/view unknown (no guessing).
  function visibleRect() {
    const c = cropRef.current;
    const L = liveRef.current;
    const v = viewSize.current;
    if (!v.w || !v.h) return null;
    const cx = v.w / 2;
    const cy = v.h / 2;
    const inv = (dx, dy) => ({
      x: cx + (dx - cx - L.tx) / Math.max(0.01, L.s),
      y: cy + (dy - cy - L.ty) / Math.max(0.01, L.s),
    });
    const p1 = inv(0, 0);
    const p2 = inv(v.w, v.h);
    const m1 = localToFrac(p1.x, p1.y);
    const m2 = localToFrac(p2.x, p2.y);
    if (!m1 || !m2) return null;
    const x0 = Math.max(0, Math.min(1, c.x + Math.min(m1.nx, m2.nx) * c.w));
    const y0 = Math.max(0, Math.min(1, c.y + Math.min(m1.ny, m2.ny) * c.h));
    const x1 = Math.max(0, Math.min(1, c.x + Math.max(m1.nx, m2.nx) * c.w));
    const y1 = Math.max(0, Math.min(1, c.y + Math.max(m1.ny, m2.ny) * c.h));
    return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.01, y1 - y0) };
  }

  // Commit a finished pan: EXACT visible viewport becomes the remote crop.
  // No-op when the finger never moved the transform (tap in Look mode).
  // At Fit (or unmoved), the visible rect equals the committed crop: snap
  // back instantly instead of waiting out a rebase.
  function commitPan() {
    const L = liveRef.current;
    if (Math.abs(L.s - 1) < 0.02 && Math.abs(L.tx) < 2 && Math.abs(L.ty) < 2) {
      resetTransformInstant();
      return;
    }
    const vis = visibleRect();
    if (!vis) {
      resetTransformInstant();
      return;
    }
    const c = cropRef.current;
    if (
      Math.abs(vis.x - c.x) < 0.001 && Math.abs(vis.y - c.y) < 0.001 &&
      Math.abs(vis.w - c.w) < 0.001 && Math.abs(vis.h - c.h) < 0.001
    ) {
      resetTransformInstant();
      return;
    }
    setCropThrottled(clampCrop(vis), true);
    scheduleRebase();
  }

  // Commit a finished pinch: the EXACT visible viewport becomes the remote
  // crop (sharpness follow). NO aspect-relock here (verified relock source):
  // normalizeAspect is only for explicit Fit/1x/2x/4x buttons.
  function commitPinch() {
    const st = pinch.current;
    const L = liveRef.current;
    // Commit when the gesture actually moved anything, either direction:
    // s<1 is a legitimate zoom-OUT and must not be discarded.
    if (!st || (Math.abs(L.s - 1) < 0.02 && Math.abs(L.tx) < 2 && Math.abs(L.ty) < 2)) {
      resetTransformInstant();
      return;
    }
    const vis = visibleRect();
    if (!vis) {
      resetTransformInstant();
      return;
    }
    setCropThrottled(clampCrop(vis), true);
    scheduleRebase();
  }

  function viewerLocal(e) {
    const t = e.nativeEvent.touches?.[0] || e.nativeEvent;
    if (typeof t.locationX === "number") return { x: t.locationX, y: t.locationY };
    return { x: t.pageX || 0, y: t.pageY || 0 };
  }

  function onViewerTouchStart(e) {
    if (current === "cam") return;
    const touches = e.nativeEvent.touches || [];
    if (sub === "Look") {
      tele(`Look start n=${touches.length} t0=${touchKeys(touches[0])} view=${viewSize.current.w}x${viewSize.current.h} origin=${originRef.current ? `${originRef.current.x},${originRef.current.y}` : "null"}`);
      if (touches.length === 2) {
        // New gesture continues from the LIVE transform (persistent model):
        // cancel any pending rebase, never snap fingers back to identity.
        // dPrev seeds the INCREMENTAL ratio below (immune to a tiny d0).
        // Origin snapshot decides the anchor space for the WHOLE gesture so
        // a late measurement can never yank mid-pinch.
        stopSettle();
        measureOrigin();
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        // Anchor space locked per gesture; a missing origin falls back to
        // center EXPLICITLY (logged once here, never silently per frame).
        const hasAnchor = Boolean(originRef.current) || Boolean(avgLocal(touches));
        if (!hasAnchor) console.log("[zoom] pinch anchor: no origin/location — center fallback");
        pinch.current = {
          dPrev: Math.hypot(dx, dy),
          crop: { ...cropRef.current },
          useOrigin: Boolean(originRef.current),
        };
      } else {
        const p = viewerLocal(e);
        pinch.current = null;
        vTouch.current = { x: p.x, y: p.y };
      }
      return;
    }
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
    if (current === "cam") return;
    const touches = e.nativeEvent.touches || [];
    if (sub === "Look") {
      if (touches.length === 2 && pinch.current) {
        // INCREMENTAL persistent zoom: each move frame scales relative to
        // the PREVIOUS frame (d/dPrev), composed onto the live transform.
        // A tiny starting span can never explode the zoom, and pinching-in
        // always zooms back out symmetrically. 60fps, no crop per frame.
        const st = pinch.current;
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        const d = Math.max(1, Math.hypot(dx, dy));
        tele(`pinch move d=${Math.round(d)} dPrev=${Math.round(st.dPrev || 0)} t0=${touchKeys(touches[0])}`);
        const vw = viewSize.current.w || 1;
        const vh = viewSize.current.h || 1;
        const pm = { x: (touches[0].pageX + touches[1].pageX) / 2, y: (touches[0].pageY + touches[1].pageY) / 2 };
        // Anchor: page midpoint minus measured viewer origin. locationX is
        // only a fallback (unreliable on some Android builds); center last.
        let ax;
        let ay;
        const o = st.useOrigin ? originRef.current : null;
        if (o) {
          ax = pm.x - o.x;
          ay = pm.y - o.y;
        } else {
          const lm = avgLocal(touches);
          ax = lm ? lm.x : vw / 2;
          ay = lm ? lm.y : vh / 2;
        }
        // INCREMENTAL zoom, total kept within [1x, MAX_ZOOM] of the monitor;
        // the content under the finger midpoint stays under the fingers.
        const { s, tx, ty } = pinchStep({
          live: liveRef.current,
          dPrev: st.dPrev,
          d,
          anchor: { x: ax, y: ay },
          view: { w: vw, h: vh },
          cropW: st.crop.w,
        });
        st.dPrev = d;
        liveRef.current = { s, tx, ty };
        scaleV.setValue(s);
        panV.setValue({ x: tx, y: ty });
        syncLive(false);
        return;
      }
      const p = viewerLocal(e);
      const start = vTouch.current;
      if (!start) {
        vTouch.current = { x: p.x, y: p.y };
        return;
      }
      // Transient pan at 60fps (same persistent model as pinch): the finger
      // moves the Animated layer instantly, the committed crop follows on
      // release (sharpness commit + guarded rebase). The old crop-driven pan
      // streamed throttled crops mid-drag and felt one step behind.
      // No hard cover-clamp here: zoom usually lives in the CROP (live scale
      // 1), so clamping to cover would freeze panning. A 25% overscroll
      // margin keeps the feel bounded; the commit itself is clamped to the
      // monitor, so steady state never shows bars.
      const vw = viewSize.current.w || 0;
      const vh = viewSize.current.h || 0;
      if (!vw || !vh || !monitorDims()) {
        vTouch.current = { x: p.x, y: p.y };
        return;
      }
      const L = liveRef.current;
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      const s = Math.max(0.01, L.s);
      const mx = Math.max(0, (vw * s - vw) / 2) + vw * 0.25;
      const my = Math.max(0, (vh * s - vh) / 2) + vh * 0.25;
      const tx = Math.max(-mx, Math.min(mx, L.tx + dx));
      const ty = Math.max(-my, Math.min(my, L.ty + dy));
      liveRef.current = { s: L.s, tx, ty };
      scaleV.setValue(L.s);
      panV.setValue({ x: tx, y: ty });
      syncLive(false);
      tele(`pan move p=${Math.round(p.x)},${Math.round(p.y)} t=${Math.round(tx)},${Math.round(ty)}`);
      vTouch.current = { x: p.x, y: p.y, panned: true };
      return;
    }
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
    if (current === "cam") {
      vTouch.current = null;
      return;
    }
    if (sub === "Look") {
      // Commit only when the LAST finger lifts. Lifting one finger of a
      // pinch hands over to a one-finger pan instead of committing (and
      // re-encoding) mid-gesture.
      const left = e.nativeEvent.touches?.length || 0;
      if (left > 0) {
        if (pinch.current) pinch.current = null;
        const p = viewerLocal(e);
        vTouch.current = { x: p.x, y: p.y };
        return;
      }
      vTouch.current = null;
      // Both pinch and pan commit their transient transform (sharpness
      // follow with guarded rebase). Pure taps reset the identity.
      if (pinch.current) {
        commitPinch();
        pinch.current = null;
      } else {
        commitPan();
      }
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

  // Slider drag: continuous center-anchored transient scale. Commit on release.
  function onSliderTouch(e) {
    const t = e.nativeEvent.touches?.[0];
    if (!t || typeof t.locationY !== "number") return;
    const h = trackHRef.current || 1;
    const z = sliderFractionToZoom(t.locationY / h);
    const c0 = cropRef.current;
    const s = clampLiveScale(z * c0.w, c0.w);
    liveRef.current = { s, tx: 0, ty: 0 };
    scaleV.setValue(s);
    panV.setValue({ x: 0, y: 0 });
    syncLive(false);
  }

  function onSliderEnd() {
    // Same persistent model as pinch: EXACT commit (no relock), guarded rebase.
    const vis = visibleRect();
    if (!vis) return;
    setCropThrottled(clampCrop(vis), true);
    scheduleRebase();
  }

  function onFrame(f) {
    // Dropped frames still carry fresh cursor/size metadata, but they were
    // NOT displayed: skip the rebase tick and byte meters so "real fps"
    // means displayed frames (honest).
    if (f?.w && f?.h) frameSize.current = { w: f.w, h: f.h };
    if (typeof f?.cx === "number") feedCursor(f.cx, f.cy);
    lastFrameAt.current = Date.now();
    if (stalled) setStalled(false);
    if (f?._dropped) return;
    if (f?.crop) lastFrameCrop.current = f.crop;
    frameTick.current += 1;
    trackFrameBytes(f?.jpeg?.length);
  }

  function cursorDot() {
    if (!cur) return null;
    const v = viewSize.current;
    if (!v.w || !v.h) return null;
    const c = cropRef.current;
    // Same exact-dims mapping as taps (see monitorDims). Null = hide, never guess.
    const d = monitorDims();
    if (!d) return null;
    const p = cursorPixels(cur.x, cur.y, v.w, v.h, d.fw, d.fh, c);
    if (!p.visible) return null;
    return <CursorDot x={p.x} y={p.y} />;
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
      ? "Geser = pan · pinch = zoom"
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
  // Effective viewport for minimap/badge/slider: committed crop + live transform.
  // Null until dims+layout ready → fall back to committed crop for badge/minimap.
  const visOrNull = (() => {
    try {
      return visibleRect();
    } catch {
      return null;
    }
  })();
  const vis = visOrNull || { ...cropRef.current };
  const effZoom = 1 / Math.max(0.01, vis.w);
  const sliderFrac = Math.max(0, Math.min(1, (effZoom - 1) / 7));

  // Mode switch always starts from an identity transform: a leftover
  // transient scale would misalign taps and flash the viewport.
  function changeSub(s) {
    resetTransformInstant();
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
        <View
          ref={wrapRef}
          style={styles.viewerWrap}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            viewSize.current = { w: width, h: height };
            measureOrigin();
          }}
          onTouchStart={onViewerTouchStart}
          onTouchMove={onViewerTouchMove}
          onTouchEnd={onViewerTouchEnd}
        >
          {/* Local transform layer: transient pinch feedback at 60fps.
              ScreenView double-buffer internals untouched underneath. */}
          <Animated.View
            style={[
              styles.zoomLayer,
              { transform: [{ scale: scaleV }, { translateX: panV.x }, { translateY: panV.y }] },
            ]}
          >
            <ScreenView style={styles.screen} onFrame={onFrame} monKey={current} />
            {cursorDot()}
          </Animated.View>
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
              <View style={styles.zoomRow}>
                <View style={styles.zoomBadge} pointerEvents="none">
                  <Text style={styles.zoomBadgeText}>ZOOM {effZoom.toFixed(1)}x</Text>
                </View>
              </View>
              <View style={styles.lookBottom}>
                <View style={styles.minimap}>
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
                    <Pressable onPress={() => zoomToWidth(0.6)} style={styles.zoomBtn}><Text style={styles.zoomText}>1x</Text></Pressable>
                    <Pressable onPress={() => zoomToWidth(0.35)} style={styles.zoomBtn}><Text style={styles.zoomText}>2x</Text></Pressable>
                    <Pressable onPress={() => zoomToWidth(0.2)} style={styles.zoomBtn}><Text style={styles.zoomText}>4x</Text></Pressable>
                    <Pressable onPress={() => zoomToWidth(Math.max(MIN_CROP, crop.w * 0.8))} style={styles.zoomBtn}><Text style={styles.zoomText}>+</Text></Pressable>
                    <Pressable onPress={() => zoomToWidth(Math.min(1, crop.w * 1.25))} style={styles.zoomBtn}><Text style={styles.zoomText}>−</Text></Pressable>
                  </View>
                </ScrollView>
              </View>
            </View>
          )}
        </View>
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
  controls: { height: CONTROL_H, paddingHorizontal: 8, paddingBottom: 6, gap: CONTROL_GAP },
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
  zoomLayer: { flex: 1 },
  screen: { flex: 1 },
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
