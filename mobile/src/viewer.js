/** Universal viewer panel: Click / Look / Bar + screen + zoom + source chips.
 * Used by PAD, TYPE and WIN so the mode behavior is identical everywhere.
 * Two modes, Look (default at app start, so a stray first touch never clicks
 * the PC) and Click. LOOK: one finger pans the camera, double tap zooms, no
 * PC input at all. CLICK: ONE finger = the PC mouse (L/R/M selector sets the
 * button; tap = abs click, drag = drag, auto-pan at the edge while zoomed).
 * In both, TWO fingers = the camera (src/camera.js): pan + pinch
 * on the UI thread (react-native-gesture-handler + Reanimated), so the view
 * follows the fingers even while the JS thread is busy decoding frames.
 * Reticle (⊕): one finger pans the camera, a tap / Klik clicks under the +.
 * Fullscreen (⛶): header, controls and tab bar hidden, landscape.
 * Frames are drawn on a whole-monitor canvas at the rect their header says
 * they cover; the PC is only asked for a (padded) region around the view, so
 * a new sharper region never moves the picture: no rebase, no jump.
 * BAR: scroll strip (scrollbar.js; natural direction by default, ⚙ toggle). The camera is shared across PAD/TYPE/WIN.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, Keyboard, Pressable, StyleSheet, Vibration, View } from "react-native";
import Text from "./AppText";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Reanimated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  LayoutAnimationConfig,
} from "react-native-reanimated";
import { useFocusEffect } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { COLORS, MonitorChips, ScreenView, getLastFullFrame } from "./components";
import { applyOrientation } from "./orientation";
import { MotionView, PressScale } from "./motion";
import VideoLayer from "./videoview";
import { VideoToggle, isVideoActive } from "./video";
import { ConnDot, LagBanner, StreamControls, StreamHealth, StreamStats, getSel, setSel, useMonitorSource, useSel } from "./controls";
import { trackFrameBytes } from "./cursor";
import { BAR_W, BarScroll, ScrollSettings, sendSwipeScroll } from "./scrollbar";
import { msg } from "./protocol";
import { pointerIcon } from "./pointer";
import { addListener, getStatus, send } from "./connection";
import { setAudioOn, useAudio } from "./audio";
import { WindowBar, useWindowStream } from "./windowstream";
import WindowThumbBar from "./winbar";
import { CONTROL_H, CONTROL_GAP, CONTROL_PAD, TOOLBAR_H } from "./tablayout";
import { useSlot } from "./viewerslot";
import { useClipSync } from "./clipsync";
import { pickAndSend } from "./filexfer";
import TransferPanel from "./transferpanel";
import {
  MAX_ZOOM,
  camFor,
  camForRect,
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
import { caretTarget, followCam, shouldRezoom, textPxFromZoom, zoomForText } from "./caretmath";
import { setCaretTextPx, useCaretPref } from "./caretpref";

const RING = 22;
const PAD_BTN_H = 48; // PAD Kiri / tengah / Kanan row (tablayout.test: rowHeight(1, [48]))
const ZOOM_MS = 220;
// While moving we ask for a roomy region so small pans need no new crop;
// once the camera rests we ask for a tight one so the view is sharp.
const PAD_MOVING = 0.8;
const PAD_REST = 0.3;
const STRETCH_MOVING = 2.6;
const STRETCH_REST = 1.7;

// Largest focal-point move (px) accepted in a single pinch event. Real
// two-finger motion stays well under this per event; a finger lifting makes
// the focal point snap by half the finger spacing.
const FOCAL_JUMP = 36;

// Zoom slider: log scale so 1x->2x, 2x->4x and 4x->8x get equal travel.
const LOG_MAX = Math.log2(MAX_ZOOM);
const ZOOM_TICKS = [1, 2, 4, 8].filter((z) => z <= MAX_ZOOM);
// Zoom ruler (camera style, under the viewer centre): one 2x step = RULER_UNIT
// px split into RULER_PER_UNIT ticks.
const RULER_W = 280;
const RULER_UNIT = 72;
const RULER_PER_UNIT = 9;
const RULER_STEP = RULER_UNIT / RULER_PER_UNIT;
const RULER_SPACE = 84; // value bubble + ruler + margins, reserved at the viewer bottom
const RULER_TICKS =Array.from({ length: Math.round(LOG_MAX * RULER_PER_UNIT) + 1 }, (_, i) => i);
// One-finger drag waits this long before starting a PC drag, so a second
// finger landing (a pinch) cancels it instead of dragging on the PC.
const DRAG_ARM_MS = 70;
// Edge auto-pan while dragging zoomed in: band width (px) and top speed
// (view px per 16 ms tick).
const EDGE_BAND = 32;
const EDGE_SPEED = 9;

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

// Touch shield for controls drawn over the viewer. A view that has a gesture
// handler becomes the touch target for gesture-handler, so a touch on the
// slider / buttons / minimap never reaches the viewer's Look pan or pinch
// underneath (without it, Look's one-finger pan stole every slider drag).
// The Manual gesture never activates, so the RN touch events and Pressables
// inside keep working exactly as before.
export function Block({ children, ...props }) {
  const g = useMemo(() => Gesture.Manual(), []);
  return (
    <GestureDetector gesture={g}>
      <View collapsable={false} {...props}>
        {children}
      </View>
    </GestureDetector>
  );
}

// Toolbar under the viewer (v2): a few equal-width icon + label buttons,
// no sideways scroll. Rarely used tools (Mode, Bar, Bidik, Lipat) live in
// the "Lainnya" popover (MoreMenu) so every label can be a plain word.
function Toolbar({ items }) {
  return (
    <Reanimated.View entering={FadeInDown.duration(180)} exiting={FadeOut.duration(120)} style={styles.toolbar}>
      {items.filter(Boolean).map((it) => (
        <PressScale
          key={it.id}
          onPress={it.onPress}
          onLongPress={it.onMenu}
          delayLongPress={350}
          hitSlop={2}
          accessibilityLabel={it.label}
          style={({ pressed }) => [styles.tbBtn, it.on && styles.tbBtnOn, pressed && styles.tbBtnPressed]}
        >
          <View style={styles.tbIconRow}>
            <MaterialCommunityIcons name={it.icon} size={18} color={it.on ? COLORS.accent : COLORS.text} />
            {!!it.onMenu && (
              // Small ▾ = its own menu (e.g. Klik: L / R / M).
              <Pressable onPress={it.onMenu} hitSlop={10} accessibilityLabel={`${it.label}: pilihan`}>
                <MaterialCommunityIcons name="menu-down" size={16} color={COLORS.muted} />
              </Pressable>
            )}
          </View>
          <Text style={[styles.tbLabel, it.on && styles.tbLabelOn]} numberOfLines={1}>{it.label}</Text>
        </PressScale>
      ))}
    </Reanimated.View>
  );
}

// "Lainnya" popover: one row per tool, icon + label + on/off state.
function MoreMenu({ items, onClose }) {
  return (
    <View style={styles.moreBox}>
      {items.filter(Boolean).map((it) => (
        <Pressable
          key={it.id}
          onPress={() => {
            it.onPress();
            onClose();
          }}
          style={({ pressed }) => [styles.moreItem, it.on && styles.moreItemOn, pressed && styles.tbBtnPressed]}
          accessibilityLabel={it.label}
        >
          <MaterialCommunityIcons name={it.icon} size={18} color={it.on ? COLORS.accent : COLORS.text} />
          <Text style={[styles.moreText, it.on && styles.tbLabelOn]}>{it.label}</Text>
          {!!it.note && <Text style={styles.moreNote}>{it.note}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

// Gesture hints are for learning: each one shows a few times, then never
// again (count kept on the phone).
const STORE_HINTS = "pcremote.hints";
const HINT_SHOWS = 3;
const hintCount = { n: 0, loaded: false };
SecureStore.getItemAsync(STORE_HINTS)
  .then((v) => {
    hintCount.n = Number(v) || 0;
    hintCount.loaded = true;
  })
  .catch(() => {
    hintCount.loaded = true;
  });
function takeHint() {
  if (!hintCount.loaded || hintCount.n >= HINT_SHOWS) return false;
  hintCount.n += 1;
  SecureStore.setItemAsync(STORE_HINTS, String(hintCount.n)).catch(() => {});
  return true;
}

function monitorLabel(current) {
  if (String(current) === "all") return "Semua";
  if (String(current) === "cam") return "Kamera";
  const n = Number(current);
  return Number.isFinite(n) ? `Layar ${n + 1}` : "Layar";
}

// Everything the viewer renders from the shared selection. Not crop (read on
// demand through cropRef) nor source (useMonitorSource): a crop update while
// panning must not re-render this whole tree.
const VIEWER_SEL_KEYS = ["mode", "bar", "clickBtn", "fold", "win", "typing", "thumbs"];

export default function ViewerPanel({ active = "" }) {
  // One viewer for PAD / TYPE / WIN (lives in the tabs layout): the active
  // tab's slot supplies what differs per tab.
  const slot = useSlot(active) || {};
  const { title = "", touchpad = false, actions = false, onTap = null, controls: children = null, overlay = null } = slot;
  // Layout C: header row + viewer (flex: 1) + fixed CONTROL_H area. The
  // control area is identical on PAD / TYPE / WIN, so the viewer is too.
  // Shared across PAD/TYPE/WIN tabs: mode, source, click button and crop.
  const shared = useSel(VIEWER_SEL_KEYS);
  const snd = useAudio();
  const bar = shared.bar;
  // Lipat: hide the tab's control area so the stream gets that height too.
  const fold = !!shared.fold;
  // TYPE live typing: the phone keyboard is up, so toolbar + control area
  // step aside and the stream keeps all the height above the keyboard.
  const typing = !!shared.typing;
  const typingRef = useRef(typing);
  typingRef.current = typing;
  // Where text goes on the PC: the last click (tap, reticle, drag end), as a
  // monitor point. Live typing zooms the short view onto it.
  const typePtRef = useRef(null);
  const typeSavedCam = useRef(null);
  // "Zoom ikut teks": while typing the camera follows the PC caret
  // ({t:"caret"}, caretmath.js). A pan hands control to the user (manual)
  // until the next click from this phone or the next typing session.
  const caretPref = useCaretPref();
  const caretPrefRef = useRef(caretPref);
  caretPrefRef.current = caretPref;
  const caretFollowRef = useRef(true);
  const caretLastRef = useRef(null); // last usable caret (caretTarget) or null
  const caretHRef = useRef(null); // caret height the zoom was computed for
  const caretZoomRef = useRef(null);
  const caretActiveRef = useRef(false); // keyboard settled, camera saved
  const [caretLabel, setCaretLabel] = useState("manual");
  // Edge-to-edge Android does not resize the window for the soft keyboard: it
  // draws over the lower part of the stream, and the camera cannot pan past
  // the monitor edge, so a field just above the PC taskbar stayed hidden.
  // While typing, the viewer box gives up exactly the covered height.
  const [kbPad, setKbPad] = useState(0);
  const kbPadRef = useRef(0);
  const mode = shared.mode === "Click" ? "Click" : "Look";
  const looking = mode === "Look";
  const clickBtn = shared.clickBtn;
  // Single-window stream: the picked app window (camera framed on it) or null.
  const win = shared.win || null;
  // Window bar (thumbnails of open windows) toggled from the toolbar / WIN tab.
  const thumbs = !!shared.thumbs;
  const { monitors, current, camError, pick } = useMonitorSource();
  // Live view of the shared crop (the viewer does not subscribe to it).
  const cropRef = useMemo(() => ({ get current() { return getSel().crop; } }), []);
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
  // Last completed tap (for double/triple-tap word/line select).
  const tapRef = useRef({ t: 0, x: 0, y: 0 });
  // Zoom slider (Look, right edge): absolute 1x..MAX_ZOOM, centre-anchored.
  const sliderDrag = useRef(null);
  const [sliderHot, setSliderHot] = useState(false);
  const sliderHotTimer = useRef(null);
  // Reticle: precise aim mode. Fullscreen: viewer only, landscape.
  const [reticle, setReticle] = useState(false);
  const [full, setFull] = useState(false);
  // v2 chrome: monitor picker / Lainnya popovers, zoom slider shown on demand
  // (Zoom button or while zoomed), PAD Drag toggle (latched mouse button).
  const [monOpen, setMonOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [dragOn, setDragOn] = useState(false);
  const [clickOpen, setClickOpen] = useState(false); // Klik ▾: L / R / M menu
  // Ruler opened from the Zoom button hides again after 3 s untouched
  // (it stays while zoomed in, so the zoom level is always readable).
  useEffect(() => {
    if (!zoomOpen || sliderHot) return undefined;
    const t = setTimeout(() => setZoomOpen(false), 3000);
    return () => clearTimeout(t);
  }, [zoomOpen, sliderHot]);
  // Touchpad tap detection: max fingers, travel and start time of a touch.
  const padTap = useRef(null);
  // A touch that began on the Drag button: no pointer move, no tap-click.
  const padSkip = useRef(false);
  // Newest frame matches the region asked for (sharp) or not yet (loading).
  const [sharp, setSharp] = useState(true);
  const sharpRef = useRef(true);
  const edgeTimer = useRef(null);
  const miniRef = useRef({ w: 0, h: 0 });
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
  // {shape, local} from the PC agent ({t:"ptr"}); null on old agents.
  const [ptr, setPtr] = useState(null);
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
      else if (event.t === "caret") onCaretRef.current?.(event);
      else if (event.t === "ptr") setPtr({ shape: String(event.shape || "arrow"), local: Boolean(event.local) });
      else if (event.t === "hello" || event.t === "close") setPtr(null);
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
      if (sliderHotTimer.current) clearTimeout(sliderHotTimer.current);
      if (edgeTimer.current) clearInterval(edgeTimer.current);
      cropTimer.current = tickTimer.current = null;
      vTouch.current = null;
    };
  }, []);

  // Held-button safety: socket close / new hello / click-button switch must
  // never leave a DOWN without UP on the PC.
  // Switching mode mid-drag finishes the drag so no button stays down.
  useEffect(() => {
    if (looking && vTouch.current) {
      cancelOneFinger(vTouch.current);
      vTouch.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looking]);
  // Live typing: once the keyboard has settled, follow the caret;
  // when it closes, go back to the camera from before.
  useEffect(() => {
    if (typing) saveTypingCam();
    else endCaretTyping();
    const id = setTimeout(() => (typing ? startCaretTyping() : unfocusTyping()), typing ? 350 : 300);
    return () => clearTimeout(id);
    // startCaretTyping/unfocusTyping only touch refs and shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);
  // Sakelar "Zoom ikut teks" flipped while typing: on = follow from now.
  useEffect(() => {
    if (typingRef.current && caretPref.follow) {
      caretFollowRef.current = true;
      caretHRef.current = null;
      applyCaret(true);
    }
    // applyCaret only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caretPref.follow]);
  useEffect(() => {
    const setPad = (v) => {
      kbPadRef.current = v;
      setKbPad(v);
    };
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      const top = e?.endCoordinates?.screenY;
      if (!Number.isFinite(top)) return;
      try {
        wrapRef.current?.measure((x, y, w, h, px, py) => {
          if (!Number.isFinite(py) || !Number.isFinite(h)) return;
          // Bottom of the box as it would be without our own pad.
          const bottom = py + h + kbPadRef.current;
          setPad(Math.max(0, Math.round(bottom - top + 4)));
        });
      } catch {
        // best-effort: without a measurement the old behaviour stays
      }
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setPad(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // Tab switch inside the shared viewer: the stream keeps running, only the
  // per-tab bits change. Drop stray touches, edge pan and fullscreen, and
  // release a held button so nothing stays down on the PC.
  const prevActive = useRef(active);
  useEffect(() => {
    if (prevActive.current === active) return;
    prevActive.current = active;
    if (vTouch.current) cancelOneFinger(vTouch.current);
    vTouch.current = null;
    stopEdgePan();
    setFull(false);
    setStreamOpen(false);
    if (dragRef.current) releaseHoldSilent();
    // the helpers only touch refs and module state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
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
        stopEdgePan();
        setFull(false);
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
    // H.264 always streams the whole monitor: zoom only scales, no crops.
    if (isVideoActive()) return;
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
  const manualRef = useRef(null);
  const pinchEndRef = useRef(null);
  const jsManual = useRef(() => manualRef.current?.()).current;
  const jsPinchEnd = useRef((s0, s1) => pinchEndRef.current?.(s0, s1)).current;
  manualRef.current = goManual;
  pinchEndRef.current = onPinchEnd;
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

  // live = called per touch-move (zoom slider, minimap): the picture moves on
  // the UI thread right away, React re-renders at most every 100 ms.
  function applyCamInstant(c, live) {
    cancelAnimation(camS);
    cancelAnimation(camX);
    cancelAnimation(camY);
    camS.value = c.s;
    camX.value = c.tx;
    camY.value = c.ty;
    camRef.current = { ...c };
    bumpTick(!live);
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


  function resetCrop() {
    animateCamTo({ s: 1, tx: 0, ty: 0 });
  }

  function onPick(id) {
    if (id !== "cam") resetCropSilent();
    pick(id);
  }

  function resetCropSilent() {
    applyCamInstant({ s: 1, tx: 0, ty: 0 });
    // Old crop, read BEFORE the store is reset below.
    const c = cropRef.current;
    setSel({ cam: { z: 1, cx: 0.5, cy: 0.5 } });
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
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

  // Two-finger camera works everywhere except the webcam source. One-finger
  // pan only in reticle mode (otherwise one finger is the PC mouse).
  const lookOn = current !== "cam";
  const panOn = lookOn && (reticle || looking);
  const startS = useSharedValue({ s: 1, tx: 0, ty: 0, fx: 0, fy: 0, k0: 1, n: 2 });
  const decayLeft = useSharedValue(0);
  const pinching = useSharedValue(false);
  const lastF = useSharedValue({ x: 0, y: 0 });
  const pinch0S = useSharedValue(1);
  const pinchEndAt = useSharedValue(0);
  const panS = useSharedValue({ tx: 0, ty: 0, ox: 0, oy: 0, lx: 0, ly: 0, held: false, mixed: false });
  // Reticle offset from the view centre (px). In reticle mode the finger
  // moves the AIM like a trackpad: the camera follows it, and once the
  // camera hits the monitor edge the + itself walks on toward the edge, so
  // corners are reachable at any zoom.
  const retOn = useSharedValue(false);
  const retX = useSharedValue(0);
  const retY = useSharedValue(0);
  const retRef = useRef({ x: 0, y: 0 });
  const jsRet = useRef((x, y) => {
    retRef.current = { x, y };
  }).current;
  useEffect(() => {
    retOn.value = reticle && lookOn;
    retX.value = 0;
    retY.value = 0;
    retRef.current = { x: 0, y: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reticle, lookOn]);
  const retStyle = useAnimatedStyle(() => ({ transform: [{ translateX: retX.value }, { translateY: retY.value }] }));

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

    // Pinch. Only two-finger events move the camera: when a finger lifts,
    // Android reports the last event(s) with the focal point snapped to the
    // finger that is still down, which used to shove the view sideways right
    // as the pinch ended. Whenever the finger count changes the gesture is
    // re-anchored at the current camera, so the focal point never jumps.
    const pinchG = Gesture.Pinch()
      .enabled(lookOn)
      .onStart((e) => {
        cancelAnimation(camS);
        cancelAnimation(camX);
        cancelAnimation(camY);
        pinching.value = true;
        pinch0S.value = camS.value;
        lastF.value = { x: e.focalX, y: e.focalY };
        startS.value = { s: camS.value, tx: camX.value, ty: camY.value, fx: e.focalX, fy: e.focalY, k0: e.scale, n: e.numberOfPointers };
      })
      .onUpdate((e) => {
        if (e.numberOfPointers < 2) return;
        // On Android the event for a lifting finger still says 2 pointers,
        // but its focal point has already snapped to the finger left behind.
        // Two fingers cannot move the midpoint that far in one event, so a
        // big jump is a pointer change: re-anchor and do not move.
        const jump = Math.hypot(e.focalX - lastF.value.x, e.focalY - lastF.value.y) > FOCAL_JUMP;
        lastF.value = { x: e.focalX, y: e.focalY };
        if (jump || e.numberOfPointers !== startS.value.n) {
          startS.value = { s: camS.value, tx: camX.value, ty: camY.value, fx: e.focalX, fy: e.focalY, k0: e.scale, n: e.numberOfPointers };
          return;
        }
        const st = startS.value;
        const vw = vwS.value;
        const vh = vhS.value;
        const fit = fitCanvas(vw, vh, aspectS.value);
        const k = e.scale / Math.max(0.0001, st.k0);
        const c = pinchCam(st, { x: st.fx, y: st.fy }, { x: e.focalX, y: e.focalY }, k, vw, vh);
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
        runOnJS(jsPinchEnd)(pinch0S.value, camS.value);
        settle(0, 0);
      })
      .onFinalize(() => {
        pinching.value = false;
        pinchEndAt.value = Date.now();
      });

    // One-finger pan. It stands still while a pinch runs, re-anchors when the
    // pinch hands back to one finger, and never flings out of a pinch (the
    // leftover finger's velocity is not a throw).
    const panG = Gesture.Pan()
      .enabled(panOn)
      .maxPointers(1)
      .minDistance(2)
      .onStart((e) => {
        cancelAnimation(camX);
        cancelAnimation(camY);
        panS.value = { tx: camX.value, ty: camY.value, ox: e.translationX, oy: e.translationY, lx: e.translationX, ly: e.translationY, held: pinching.value, mixed: pinching.value };
        if (!retOn.value && !pinching.value) runOnJS(jsManual)();
      })
      .onUpdate((e) => {
        if (pinching.value || e.numberOfPointers !== 1) {
          panS.value = { ...panS.value, held: true, mixed: true };
          return;
        }
        if (panS.value.held) {
          panS.value = { tx: camX.value, ty: camY.value, ox: e.translationX, oy: e.translationY, lx: e.translationX, ly: e.translationY, held: false, mixed: true };
          return;
        }
        const st = panS.value;
        const vw = vwS.value;
        const vh = vhS.value;
        const fit = fitCanvas(vw, vh, aspectS.value);
        const { mx, my } = maxPan(camS.value, fit.bw, fit.bh, vw, vh);
        if (retOn.value) {
          // Aim mode: finger delta moves the aim. Virtual camera v = t - r;
          // the camera takes what it can, the + takes the rest.
          const dx = e.translationX - st.lx;
          const dy = e.translationY - st.ly;
          panS.value = { ...st, lx: e.translationX, ly: e.translationY };
          const vX = camX.value - retX.value - dx;
          const vY = camY.value - retY.value - dy;
          const tX = Math.max(-mx, Math.min(mx, vX));
          const tY = Math.max(-my, Math.min(my, vY));
          const limX = Math.max(0, vw / 2 - 2);
          const limY = Math.max(0, vh / 2 - 2);
          camX.value = tX;
          camY.value = tY;
          retX.value = Math.max(-limX, Math.min(limX, tX - vX));
          retY.value = Math.max(-limY, Math.min(limY, tY - vY));
          const now = Date.now();
          if (now - lastSyncS.value > 80) {
            lastSyncS.value = now;
            runOnJS(jsRet)(retX.value, retY.value);
            runOnJS(jsMove)(camS.value, camX.value, camY.value);
          }
          return;
        }
        camX.value = rubber(st.tx + e.translationX - st.ox, mx, vw);
        camY.value = rubber(st.ty + e.translationY - st.oy, my, vh);
        const now = Date.now();
        if (now - lastSyncS.value > 80) {
          lastSyncS.value = now;
          runOnJS(jsMove)(camS.value, camX.value, camY.value);
        }
      })
      .onEnd((e) => {
        if (pinching.value) return; // the pinch settles the camera itself
        if (retOn.value) {
          runOnJS(jsRet)(retX.value, retY.value);
          settle(0, 0);
          return;
        }
        const recent = Date.now() - pinchEndAt.value < 250;
        if (panS.value.mixed || recent) settle(0, 0);
        else settle(e.velocityX, e.velocityY);
      });

    // Double-tap zoom in Look / reticle: in Click mode a double tap is a PC
    // double-click (word select).
    const doubleTapG = Gesture.Tap()
      .enabled(panOn)
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
  }, [lookOn, panOn]);

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

  // ---- One finger = PC mouse (raw touches; two fingers = gesture handler) --

  function stopEdgePan() {
    if (edgeTimer.current) {
      clearInterval(edgeTimer.current);
      edgeTimer.current = null;
      const c = camRef.current;
      onCamRest(c.s, c.tx, c.ty);
    }
  }

  // Dragging near the viewer edge while zoomed slides the camera that way,
  // and keeps the PC drag under the (still) finger moving with it.
  function updateEdgePan(st) {
    const g = geom();
    if (!g || camRef.current.s <= 1.01) return stopEdgePan();
    const ex = st.px < EDGE_BAND ? -1 : st.px > g.vw - EDGE_BAND ? 1 : 0;
    const ey = st.py < EDGE_BAND ? -1 : st.py > g.vh - EDGE_BAND ? 1 : 0;
    st.edge = { x: ex, y: ey };
    if (!ex && !ey) return stopEdgePan();
    if (edgeTimer.current) return;
    edgeTimer.current = setInterval(() => {
      const t = vTouch.current;
      const gg = geom();
      if (!t || !t.dragging || !t.edge || !gg) return stopEdgePan();
      const c = camRef.current;
      // Moving the view right = canvas moves left.
      const next = clampCam(
        { s: c.s, tx: c.tx - t.edge.x * EDGE_SPEED, ty: c.ty - t.edge.y * EDGE_SPEED },
        gg.fit.bw,
        gg.fit.bh,
        gg.vw,
        gg.vh,
      );
      if (Math.abs(next.tx - c.tx) < 0.1 && Math.abs(next.ty - c.ty) < 0.1) return;
      applyCamInstant(next);
      requestRegion(true);
      const m = mapToMonitor(t.px, t.py);
      if (m) send(msg.drag("move", m.x, m.y, clickBtnRef.current));
    }, 16);
  }

  // Centre of the view (reticle) mapped to the monitor.
  function clickAtReticle(btn) {
    const g = geom();
    if (!g) return noteBlocked();
    const r = retRef.current;
    const v = viewToMonitor(g.vw / 2 + r.x, g.vh / 2 + r.y, camRef.current, g.fit, g.vw, g.vh);
    send(msg.abs(clamp01(v.x), clamp01(v.y), btn || clickBtnRef.current));
    noteTypePoint(clamp01(v.x), clamp01(v.y));
  }

  function noteTypePoint(x, y) {
    typePtRef.current = { x, y };
    // A click from this phone while typing: follow the caret again.
    if (!typingRef.current) return;
    if (!caretFollowRef.current) {
      caretFollowRef.current = true;
      caretHRef.current = null;
      applyCaret(true);
    } else applyCaret(false); // catch up after a drag held the camera still
  }

  // Pixel height of what is being viewed (caret heights are relative to it).
  // "all": the tallest monitor, right for the usual side-by-side layout.
  function viewPxH() {
    const ms = monitors || [];
    if (current === "all") return Math.max(0, ...ms.map((m) => m.h || 0));
    return ms.find((m) => String(m.id) === String(current))?.h || 0;
  }

  function syncCaretLabel() {
    const next = caretFollowRef.current && caretLastRef.current ? "ikut caret" : "manual";
    setCaretLabel((l) => (l === next ? l : next));
  }

  const onCaretRef = useRef(null);
  onCaretRef.current = (m) => {
    caretLastRef.current = caretTarget(m, viewPxH());
    if (typingRef.current) applyCaret(false);
  };

  // Aim at the caret. No caret -> the camera stays where it is.
  function applyCaret(force) {
    syncCaretLabel();
    if (!caretActiveRef.current || !typingRef.current || !caretPrefRef.current.follow || !caretFollowRef.current || current === "cam") return;
    if (vTouch.current?.dragging || pinching.value) return;
    const t = caretLastRef.current;
    const g = geom();
    if (!t || !g) return;
    if (t.validH && (force || shouldRezoom(caretHRef.current, t.h))) {
      caretHRef.current = t.h;
      caretZoomRef.current = zoomForText(caretPrefRef.current.textPx, t.h, g.fit);
    }
    const c = followCam(camRef.current, t, caretZoomRef.current ?? camRef.current.s, g.fit, g.vw, g.vh);
    if (c) animateCamTo(c);
  }

  // Typing starts: remember the camera at once, before any caret move.
  function saveTypingCam() {
    const g = geom();
    if (g && current !== "cam" && !typeSavedCam.current) typeSavedCam.current = camToNorm(camRef.current, g.fit, g.vw, g.vh);
  }

  function endCaretTyping() {
    caretActiveRef.current = false;
    caretLastRef.current = null;
    caretHRef.current = null;
    caretZoomRef.current = null;
  }

  // Keyboard settled: follow the caret from now on.
  function startCaretTyping() {
    saveTypingCam();
    caretActiveRef.current = true;
    caretFollowRef.current = true;
    caretHRef.current = null;
    caretZoomRef.current = null;
    applyCaret(true);
  }

  function goManual() {
    if (!typingRef.current || !caretFollowRef.current) return;
    caretFollowRef.current = false;
    syncCaretLabel();
  }

  // Pinch while typing sets how big text looks on the phone (kept, and the
  // camera keeps following). A two-finger move without zoom is a pan.
  function onPinchEnd(s0, s1) {
    if (!typingRef.current) return;
    if (Math.abs(s1 - s0) / Math.max(0.01, s0) < 0.05) {
      goManual();
      return;
    }
    if (!caretPrefRef.current.follow) return;
    caretFollowRef.current = true;
    caretZoomRef.current = s1;
    const t = caretLastRef.current;
    const g = geom();
    if (t?.validH && g) {
      setCaretTextPx(textPxFromZoom(s1, t.h, g.fit));
      caretHRef.current = t.h;
    }
    syncCaretLabel();
  }

  function unfocusTyping() {
    const saved = typeSavedCam.current;
    typeSavedCam.current = null;
    const g = geom();
    if (!saved || !g) return;
    animateCamTo(normToCam(saved, g.fit, g.vw, g.vh));
  }

  function onViewerTouchStart(e) {
    if (current === "cam") return;
    // Look: one finger belongs to the camera, never to the PC mouse.
    if (looking && !reticle) {
      vTouch.current = null;
      return;
    }
    const touches = e.nativeEvent.touches || [];
    if (touches.length > 1) {
      // A second finger: this is a pinch, cancel the one-finger action.
      if (vTouch.current) cancelOneFinger(vTouch.current);
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
    vTouch.current = { x: p.x, y: p.y, t: now, moved: false, dragging: false, multi: false, doubleTap: Boolean(doubleTap) };
  }

  function cancelOneFinger(st) {
    st.multi = true;
    if (st.dragging) {
      // Rare: the drag had already started. Finish it where it is so the PC
      // button is never left down.
      const m = mapToMonitor(st.px ?? st.x, st.py ?? st.y);
      if (m) send(msg.drag("end", m.x, m.y, clickBtnRef.current));
      st.dragging = false;
    }
    stopEdgePan();
  }

  function onViewerTouchMove(e) {
    if (current === "cam") return;
    const st = vTouch.current;
    if (!st) return;
    const touches = e.nativeEvent.touches || [];
    if (touches.length > 1) {
      if (!st.multi) cancelOneFinger(st);
      return;
    }
    if (st.multi || reticle) return;
    const p = viewerLocal(e);
    // Text-selection precision: 5px threshold (was 8px — small text drags
    // were misclassified as taps and the selection never started).
    // Hold-button drags own the button: direct viewer drags are ignored while
    // Hold is active so two drag sources never fight over one button.
    if (dragRef.current) return;
    const dist = Math.hypot(p.x - st.x, p.y - st.y);
    if (dist > 5) st.moved = true;
    st.px = p.x;
    st.py = p.y;
    if (st.moved && !st.dragging) {
      if (Date.now() - st.t < DRAG_ARM_MS) return;
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
      send(msg.drag("move", m.x, m.y, clickBtnRef.current));
      updateEdgePan(st);
    }
  }

  function onViewerTouchEnd(e) {
    if (current === "cam") {
      vTouch.current = null;
      return;
    }
    const st = vTouch.current;
    const touchesLeft = e.nativeEvent.touches?.length || 0;
    if (touchesLeft > 0) return;
    vTouch.current = null;
    lastRef.current = null;
    stopEdgePan();
    if (!st || st.multi) return;
    // While Hold owns the button, viewer taps/drags are suppressed entirely
    // (otherwise a tap would fire an extra click mid-selection).
    if (dragRef.current) return;
    if (reticle) {
      const p = viewerLocal(e);
      const still = Math.hypot((p.x ?? st.x) - st.x, (p.y ?? st.y) - st.y) < 8;
      if (still && Date.now() - st.t < 400) clickAtReticle();
      return;
    }
    if (st.dragging) {
      // End at the RELEASE point (last move), not the start point — ending at
      // start collapsed text selections back to a caret.
      const ex = st.px ?? st.x;
      const ey = st.py ?? st.y;
      const m = mapToMonitor(ex, ey);
      if (m) {
        send(msg.drag("end", m.x, m.y, clickBtnRef.current));
        noteTypePoint(m.x, m.y);
      }
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
      noteTypePoint(m.x, m.y);
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
    const touches = e.nativeEvent.touches;
    const t = touches[0];
    if (padSkip.current) {
      padTap.current = null;
      lastRef.current = null;
      return;
    }
    lastRef.current = { x: t.pageX, y: t.pageY };
    const p = padTap.current;
    if (!p || touches.length === 1) padTap.current = { at: Date.now(), fingers: touches.length, travel: 0 };
    else p.fingers = Math.max(p.fingers, touches.length);
  }

  function onTouchMove(e) {
    const touches = e.nativeEvent.touches;
    const t = touches[0];
    if (padSkip.current || !t) return;
    const last = lastRef.current;
    if (!last) {
      lastRef.current = { x: t.pageX, y: t.pageY };
      return;
    }
    const dx = (t.pageX - last.x) * 1.5;
    const dy = (t.pageY - last.y) * 1.5;
    lastRef.current = { x: t.pageX, y: t.pageY };
    if (padTap.current) {
      padTap.current.fingers = Math.max(padTap.current.fingers, touches.length);
      padTap.current.travel += Math.abs(dx) + Math.abs(dy);
    }
    if (touches.length === 2) {
      // Direction/speed follow the ⚙ scroll setting (natural by default).
      sendSwipeScroll(dx, dy);
      return;
    }
    send(msg.move(dx, dy));
  }

  function onTouchEnd(e) {
    lastRef.current = null;
    // Touchpad taps (laptop style): short touch that barely moved.
    // 1 finger = click, 2 fingers = right click. Waits for the last finger.
    if ((e?.nativeEvent?.touches?.length || 0) > 0) return;
    if (padSkip.current) {
      padSkip.current = false;
      padTap.current = null;
      return;
    }
    const p = padTap.current;
    padTap.current = null;
    if (!p || Date.now() - p.at > 250 || p.travel > 12) return;
    if (dragRef.current) return; // Drag latched: taps must not click through
    if (p.fingers === 2) send(msg.click("right", true, true));
    else if (p.fingers === 1) send(msg.click("left", true, true));
  }

  function onPadCancel() {
    lastRef.current = null;
    padTap.current = null;
    padSkip.current = false;
  }

  function toggleDrag() {
    if (dragRef.current) {
      releaseLeft();
      setDragOn(false);
    } else {
      holdLeft();
      setDragOn(true);
    }
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
    setDragOn(false);
    if (btn) {
      dragRef.current = false;
      try {
        send(msg.click(btn, false, true));
      } catch {
        // teardown is best-effort
      }
    }
  }

  // Zoom slider: RELATIVE drag on a log scale. Touching never jumps the
  // zoom; sliding up one full track = 1x -> MAX_ZOOM. Zooms around the view
  // centre, live. A light buzz when passing 1x / 2x / 4x / 8x, and a gentle
  // snap onto a tick when released close to it.
  function zoomFromLog(l, n, g) {
    const z = Math.pow(2, Math.max(0, Math.min(LOG_MAX, l)));
    applyCamInstant(camFor(z, n.cx, n.cy, g.fit, g.vw, g.vh), true);
    requestRegion(true);
  }

  function heatSlider(on) {
    if (sliderHotTimer.current) clearTimeout(sliderHotTimer.current);
    sliderHotTimer.current = null;
    if (on) setSliderHot(true);
    else sliderHotTimer.current = setTimeout(() => setSliderHot(false), 2500);
  }

  // Ruler (A2): the scale slides under a fixed centre needle. Dragging the
  // finger left brings bigger zoom to the needle (RULER_UNIT px per 2x).
  // A short tap without sliding jumps to the 1x/2x/4x/8x mark nearest to
  // where it landed.
  function onSliderStart(e) {
    const t = e.nativeEvent.touches?.[0];
    const g = geom();
    if (!t || !g) return;
    heatSlider(true);
    const l0 = Math.log2(Math.max(1, camRef.current.s || 1));
    sliderDrag.current = {
      x0: t.pageX,
      lx: e.nativeEvent.locationX,
      at: Date.now(),
      moved: false,
      l0,
      n: camToNorm(camRef.current, g.fit, g.vw, g.vh),
    };
  }

  function onSliderMove(e) {
    const t = e.nativeEvent.touches?.[0];
    const st = sliderDrag.current;
    const g = geom();
    if (!t || !st || !g) return;
    if (!st.moved && Math.abs(t.pageX - st.x0) < 6) return; // still a tap
    st.moved = true;
    const l = Math.max(0, Math.min(LOG_MAX, st.l0 + (st.x0 - t.pageX) / RULER_UNIT));
    // Buzz when crossing an integer power of two (a tick).
    const prev = st.lastL ?? st.l0;
    if (Math.floor(prev + 1e-6) !== Math.floor(l + 1e-6) || (l === 0 && prev > 0) || (l === LOG_MAX && prev < LOG_MAX)) {
      try {
        Vibration.vibrate(8);
      } catch {
        // haptics optional
      }
    }
    st.lastL = l;
    zoomFromLog(l, st.n, g);
  }

  function onSliderEnd() {
    const st = sliderDrag.current;
    sliderDrag.current = null;
    heatSlider(false);
    const g = geom();
    if (st && g && !st.moved && Date.now() - st.at < 350 && typeof st.lx === "number") {
      // Tap: jump to the nearest power-of-two mark under the finger.
      const target = Math.max(0, Math.min(Math.floor(LOG_MAX), Math.round(st.l0 + (st.lx - RULER_W / 2) / RULER_UNIT)));
      try {
        Vibration.vibrate(8);
      } catch {
        // haptics optional
      }
      animateCamTo(camFor(Math.pow(2, target), st.n.cx, st.n.cy, g.fit, g.vw, g.vh));
      return;
    }
    if (st && g && typeof st.lastL === "number") {
      const near = Math.round(st.lastL);
      if (Math.abs(st.lastL - near) < 0.12) {
        animateCamTo(camFor(Math.pow(2, near), st.n.cx, st.n.cy, g.fit, g.vw, g.vh));
        return;
      }
    }
    const c = camRef.current;
    onCamRest(c.s, c.tx, c.ty);
  }

  // Minimap: tap or drag to put that point of the monitor in the centre.
  function onMiniTouch(e, end) {
    const g = geom();
    const t = e.nativeEvent.touches?.[0] || e.nativeEvent;
    const { w, h } = miniRef.current;
    if (!g || !w || !h || typeof t.locationX !== "number") return;
    heatSlider(true);
    const cx = clamp01(t.locationX / w);
    const cy = clamp01(t.locationY / h);
    applyCamInstant(camFor(camRef.current.s, cx, cy, g.fit, g.vw, g.vh), !end);
    requestRegion(true);
    if (end) {
      heatSlider(false);
      const c = camRef.current;
      onCamRest(c.s, c.tx, c.ty);
    }
  }

  function toggleFull() {
    setFull((v) => !v);
  }

  // Fullscreen: hide the tab bar + status bar and turn landscape; restore on
  // exit. PAD / TYPE / WIN are all portrait tabs.
  const fullMounted = useRef(false);
  useEffect(() => {
    // First run = mount: the tab's own focus lock already decided.
    if (!fullMounted.current) {
      fullMounted.current = true;
      return;
    }
    // The tabs layout hides the tab bar while full.
    setSel({ full });
    applyOrientation(full ? "landscape" : "portrait");
  }, [full]);
  useEffect(() => () => setSel({ full: false }), []);

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
    // Sharp = the newest shown frame is the region we last asked for.
    const want = lastSentCrop || { x: 0, y: 0, w: 1, h: 1 };
    let got = null;
    try {
      got = snapCrop(f?.crop);
    } catch {
      got = null;
    }
    const ok = !!got && Math.abs(got.x - want.x) < 0.003 && Math.abs(got.y - want.y) < 0.003 &&
      Math.abs(got.w - want.w) < 0.003 && Math.abs(got.h - want.h) < 0.003;
    if (ok !== sharpRef.current) {
      sharpRef.current = ok;
      setSharp(ok);
    }
  }

  // H.264 (beta): access-unit metadata keeps cursor, stall watchdog and
  // meters alive exactly like JPEG frames do.
  function onVideoPacket(p) {
    if (p.w && p.h) frameSize.current = { w: p.w, h: p.h };
    if (typeof p.cx === "number") feedCursor(p.cx, p.cy);
    lastFrameAt.current = Date.now();
    if (stalled) setStalled(false);
    trackFrameBytes(p.bytes);
    if (!sharpRef.current) {
      sharpRef.current = true;
      setSharp(true);
    }
  }

  // Back on JPEG: ask for the region around the current view again.
  function onVideoActive(on) {
    if (!on) requestRegion(false);
  }

  // Stable identities for the memoized stream layers; each call reaches the
  // newest closure (fresh monitors/current/stalled) through the ref.
  const streamCbs = useRef(null);
  streamCbs.current = { onFrame, onVideoPacket, onVideoActive };
  const stableOnFrame = useCallback((f) => streamCbs.current.onFrame(f), []);
  const stableOnPacket = useCallback((p) => streamCbs.current.onVideoPacket(p), []);
  const stableOnActive = useCallback((on) => streamCbs.current.onVideoActive(on), []);

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
  const btnName = clickBtn === "right" ? "klik kanan" : clickBtn === "middle" ? "klik tengah" : "klik";
  const hintText = reticle
    ? "Geser = gerakkan + (sampai ujung layar) · tap = " + btnName + " · 2 jari = zoom"
    : looking
      ? "Look: geser = lihat · 2 jari = zoom · tap 2x = zoom · Click untuk klik"
      : "Click: 1 jari = " + btnName + " / drag · 2 jari = geser / zoom";
  const [hintOn, setHintOn] = useState(false);
  // Brief chip when the clipboard just synced (clipsync.js).
  const clipNotice = useClipSync().notice;
  useEffect(() => {
    if (!takeHint()) return undefined;
    setHintOn(true);
    const t = setTimeout(() => setHintOn(false), 3500);
    return () => clearTimeout(t);
  }, [reticle, clickBtn, looking]);
  // Minimap / badge / slider read the JS camera mirror (~10 Hz while moving).
  const g0 = geom();
  const vis = g0 ? visibleRect(camRef.current, g0.fit, g0.vw, g0.vh) : { x: 0, y: 0, w: 1, h: 1 };
  const effZoom = camRef.current.s || 1;
  // Ruler tape follows the live zoom on the UI thread (pinch included, no
  // React render per move); only the value bubble waits for the next render.
  const tapeStyle = useAnimatedStyle(() => {
    const z = camS.value > 1 ? camS.value : 1;
    const l = Math.min(LOG_MAX, Math.log2(z));
    return { transform: [{ translateX: RULER_W / 2 - l * RULER_UNIT }] };
  });
  const zoomed = effZoom > 1.02;
  const camTools = current !== "cam";
  const rulerOn = camTools && (zoomOpen || zoomed || sliderHot);
  // Jendela opens in the control area under the viewer, not over the stream.
  const thumbsOn = thumbs && current !== "cam";
  const winStream = useWindowStream({
    win,
    current,
    onMonitor: (id) => onPick(id),
    fitTo: (r) => {
      const g = geom();
      if (g) animateCamTo(camForRect(r, g.fit, g.vw, g.vh));
    },
    reset: resetCrop,
  });
  function pickMonitorChip(id) {
    // Choosing a screen by hand leaves single-window mode.
    if (getSel().win) setSel({ win: null });
    onPick(id);
  }
  const miniAspect = monitorAspect() || 16 / 9;
  const MINI_W = full ? 120 : 104;
  const miniH = Math.round(Math.max(36, Math.min(90, MINI_W / miniAspect)));
  // Top-left banners (window bar, slow link) start right of the minimap.
  const topLeft = (bar ? BAR_W + 4 : 8) + (camTools && zoomed ? MINI_W + 6 : 0);
  const thumb = zoomed ? getLastFullFrame(current) : null;

  return (
    // skipEntering: on mount (tab switch) the chrome just appears; entering
    // fades only play when it comes back later (e.g. leaving typing mode).
    <LayoutAnimationConfig skipEntering>
    <View style={styles.root}>
      {full && <StatusBar hidden />}
      {!full && !typing && (
      <Reanimated.View entering={FadeInUp.duration(180)} exiting={FadeOut.duration(120)} style={styles.topRow}>
        {!!title && <Text style={styles.title}>{title}</Text>}
        <ConnDot />
        <View style={styles.topScroll}>
          <Pressable
            onPress={() => {
              setMoreOpen(false);
              setMonOpen((v) => !v);
            }}
            hitSlop={6}
            style={[styles.monPick, monOpen && styles.subTabActive]}
            accessibilityLabel="Pilih layar"
          >
            <MaterialCommunityIcons name={String(current) === "cam" ? "camera-outline" : "monitor"} size={15} color={COLORS.text} />
            <Text style={styles.monPickText} numberOfLines={1}>{monitorLabel(current)}</Text>
            <MaterialCommunityIcons name={monOpen ? "chevron-up" : "chevron-down"} size={16} color={COLORS.muted} />
          </Pressable>
        </View>
        <Pressable
          onPress={() => setStreamOpen((v) => !v)}
          style={[styles.gear, streamOpen && styles.subTabActive]}
          hitSlop={6}
          accessibilityLabel="Pengaturan stream"
        >
          <Text style={[styles.gearText, streamOpen && styles.subTextActive]}>⚙</Text>
        </Pressable>
      </Reanimated.View>
      )}
      <View style={[styles.viewerBox, full && styles.viewerBoxFull, typing && kbPad > 0 && { minHeight: 0, marginBottom: 6 + kbPad }]}>
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
            if (typingRef.current && caretActiveRef.current && caretFollowRef.current && caretLastRef.current && prev.w && (prev.w !== width || prev.h !== height)) {
              // Keyboard just resized the view: re-aim at the caret.
              applyCaret(true);
            } else if (a && prev.w && prev.h && (prev.w !== width || prev.h !== height)) {
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
            <ScreenView style={styles.canvasFill} onFrame={stableOnFrame} monKey={current} placed resolveCrop={snapCrop} />
            <VideoLayer enabled={current !== "cam"} onPacket={stableOnPacket} onActive={stableOnActive} />
          </Reanimated.View>
          {!!cur && (
            <Reanimated.View
              pointerEvents="none"
              style={[styles.ring, ptr?.local && styles.ringLocal, ptr?.shape === "none" && styles.ringHidden, ringStyle]}
            >
              {!!pointerIcon(ptr?.shape) && (
                <MaterialCommunityIcons name={pointerIcon(ptr?.shape)} size={14} color="#ffffff" style={styles.ringIcon} />
              )}
            </Reanimated.View>
          )}
        </View>
        </GestureDetector>
        {/* Look controls sit beside (not inside) the gesture view so a drag on
            the slider or a tap on a button never pans the camera. */}
          {rulerOn && (
            <View style={[styles.rulerWrap, bar && styles.shiftForBar]} pointerEvents="box-none">
              <View style={styles.rulerValue} pointerEvents="none">
                <Text style={styles.rulerValueText}>{effZoom.toFixed(1)}x</Text>
              </View>
              <Block
                style={styles.ruler}
                onTouchStart={onSliderStart}
                onTouchMove={onSliderMove}
                onTouchEnd={onSliderEnd}
                onTouchCancel={onSliderEnd}
                accessibilityLabel={`Zoom ${effZoom.toFixed(1)}x, geser untuk mengubah`}
              >
                <Reanimated.View pointerEvents="none" style={[styles.tape, tapeStyle]}>
                  {RULER_TICKS.map((i) => (
                    <View key={i} style={[styles.rTick, i % RULER_PER_UNIT === 0 && styles.rTickBig, { left: i * RULER_STEP }]} />
                  ))}
                  {ZOOM_TICKS.map((z) => (
                    <Text key={z} style={[styles.rLabel, { left: Math.log2(z) * RULER_UNIT - 12 }]}>
                      {z}x
                    </Text>
                  ))}
                </Reanimated.View>
                <View pointerEvents="none" style={styles.needle} />
              </Block>
            </View>
          )}
          {/* Clean viewer (B): only the zoom ruler sits at the bottom; the
              minimap is a small corner card while zoomed; L/R/M lives in
              the toolbar's Klik ▾ menu; Jendela opens in the control area. */}
          {camTools && zoomed && (
                  <Block
                    style={[styles.minimap, styles.miniCorner, bar && styles.shiftForBar, { width: MINI_W, height: miniH }]}
                    onLayout={(e) => {
                      miniRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
                    }}
                    onTouchStart={(e) => onMiniTouch(e, false)}
                    onTouchMove={(e) => onMiniTouch(e, false)}
                    onTouchEnd={(e) => onMiniTouch(e, true)}
                  >
                    {!!thumb && (
                      <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="stretch" fadeDuration={0} pointerEvents="none" />
                    )}
                    <View
                      pointerEvents="none"
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
                  </Block>
          )}
          {camTools && reticle && (
            <View style={[styles.lookBar, bar && styles.shiftForBar, { bottom: rulerOn ? RULER_SPACE : 0 }]} pointerEvents="box-none">
              <Block style={styles.aimWrap}>
                <Pressable onPress={() => clickAtReticle()} style={styles.aimBtn} hitSlop={4}>
                  <Text style={styles.aimText}>Klik</Text>
                </Pressable>
              </Block>
            </View>
          )}
          {camTools && reticle && (
            <Reanimated.View pointerEvents="none" style={[styles.reticle, retStyle]}>
              <View style={[styles.retLine, { width: 2, height: 18, top: 0, left: 19 }]} />
              <View style={[styles.retLine, { width: 2, height: 18, bottom: 0, left: 19 }]} />
              <View style={[styles.retLine, { height: 2, width: 18, left: 0, top: 19 }]} />
              <View style={[styles.retLine, { height: 2, width: 18, right: 0, top: 19 }]} />
              <View style={styles.retDot} />
            </Reanimated.View>
          )}
          {(full || (camTools && zoomed)) && (
            <Block style={[styles.toolRow, bar && styles.shiftForBar, camTools && zoomed && { top: 12 + miniH }]}>
              {full && (
                <Pressable onPress={toggleFull} style={[styles.toolBtn, styles.toolBtnOn]} hitSlop={4} accessibilityLabel="Keluar layar penuh">
                  <Text style={[styles.toolText, styles.toolTextOn]}>✕</Text>
                </Pressable>
              )}
              {camTools && zoomed && (
                <View style={styles.sharpPill} pointerEvents="none">
                  <View style={[styles.sharpDot, { backgroundColor: sharp ? "#34c759" : "#ff9f0a" }]} />
                  <Text style={styles.sharpText}>{sharp ? "tajam" : "memuat"}</Text>
                </View>
              )}
            </Block>
          )}
        <View style={[styles.overlayTop, bar && styles.shiftForBar]} pointerEvents="none">
          {hintOn && !streamOpen && (
            <Reanimated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={styles.hintPill}>
              <Text style={styles.hint}>{hintText}</Text>
            </Reanimated.View>
          )}
          {!!clipNotice && (
            <Reanimated.View entering={FadeInDown.duration(160)} exiting={FadeOut.duration(200)} style={styles.clipChip}>
              <MaterialCommunityIcons name="clipboard-text-outline" size={13} color="#ffffff" />
              <Text style={styles.clipChipText}>{clipNotice.dir === "in" ? "Clipboard PC → HP" : "Clipboard HP → PC"}</Text>
            </Reanimated.View>
          )}
          {stalled && (
            <Reanimated.View entering={FadeInDown.duration(200)} exiting={FadeOut.duration(150)} style={styles.stalled}>
              <Text style={styles.stalledText}>Stream terhenti — mencoba lagi otomatis…</Text>
            </Reanimated.View>
          )}
          {typing && caretPref.follow && current !== "cam" && (
            <View style={styles.caretBadge} pointerEvents="none">
              <Text style={styles.caretBadgeText}>{caretLabel}</Text>
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
        {!!ptr?.local && current !== "cam" && (
          <View style={styles.localChip} pointerEvents="none">
            <MaterialCommunityIcons name="mouse" size={13} color="#ff9f0a" />
            <Text style={styles.localChipText}>Mouse PC sedang dipakai</Text>
          </View>
        )}
        {!!win && current !== "cam" && (
          <Block style={[styles.winWrap, { left: topLeft }]}>
            <WindowBar
              win={win}
              onRefit={() => {
                send(msg.winAct(win.id, "focus"));
                if (!win.min) winStream.fitTo(win);
                else winStream.refresh();
              }}
              onExit={winStream.exit}
            />
          </Block>
        )}
        {!streamOpen && !full && current !== "cam" && (
          <Block style={[styles.lagWrap, !!win && styles.lagBelowWin, { left: topLeft }]} pointerEvents="box-none">
            <LagBanner />
          </Block>
        )}
        {!streamOpen && (
          <Block style={styles.fpsPill}>
            <Pressable onPress={() => setStreamOpen(true)} hitSlop={6} style={styles.fpsStats} accessibilityLabel="Status stream, buka detail">
              <StreamHealth />
            </Pressable>
            {/* PC sound (was "Suara" in the toolbar): only with an APK that has
                the native player and an agent that streams it. Off = the PC
                stops sending audio. */}
            {snd.supported && snd.agent && (
              <Pressable
                onPress={() => setAudioOn(!snd.on)}
                hitSlop={8}
                style={styles.fpsSound}
                accessibilityLabel={snd.on ? "Matikan suara PC" : "Nyalakan suara PC"}
              >
                <MaterialCommunityIcons
                  name={snd.error ? "volume-alert" : snd.on ? "volume-high" : "volume-off"}
                  size={14}
                  color={snd.error ? "#ff9f0a" : snd.on ? "#ffffff" : "rgba(255,255,255,0.55)"}
                />
              </Pressable>
            )}
          </Block>
        )}
        {streamOpen && <Pressable style={StyleSheet.absoluteFill} onPress={() => setStreamOpen(false)} accessibilityLabel="Tutup pengaturan stream" />}
        <MotionView visible={streamOpen} kind="pop" origin="top right" style={styles.streamPop}>
          <Block onTouchStart={armStreamTimer}>
            <View style={styles.popStats}>
              <StreamStats />
            </View>
            <StreamControls compact />
            <ScrollSettings />
            <VideoToggle />
          </Block>
        </MotionView>
        {bar && (
          <Block style={styles.bar}>
            <BarScroll />
          </Block>
        )}
        {overlay}
        {!full && <TransferPanel style={styles.transferWrap} />}
        {(monOpen || moreOpen || clickOpen) && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              setMonOpen(false);
              setMoreOpen(false);
              setClickOpen(false);
            }}
            accessibilityLabel="Tutup menu"
          />
        )}
        <MotionView visible={monOpen && !typing} kind="pop" origin="top left" style={styles.monPop}>
          <Block style={styles.monBox}>
            <MonitorChips
              monitors={monitors}
              current={current}
              onPick={(id) => {
                pickMonitorChip(id);
                setMonOpen(false);
              }}
            />
          </Block>
        </MotionView>
        {/* Klik ▾: which mouse button a tap on the screen clicks. */}
        <MotionView visible={clickOpen && !typing} kind="pop" origin="bottom left" style={styles.clickPop}>
          <Block>
            <MoreMenu
              onClose={() => setClickOpen(false)}
              items={[
                { id: "left", icon: "mouse", label: "Kiri (L)", note: "klik biasa" },
                { id: "right", icon: "mouse", label: "Kanan (R)", note: "menu konteks" },
                { id: "middle", icon: "mouse", label: "Tengah (M)", note: "buka di tab baru" },
              ].map((b) => ({
                ...b,
                on: !looking && clickBtn === b.id,
                // Picking a button also switches to Klik mode.
                onPress: () => setSel({ clickBtn: b.id, mode: "Click" }),
              }))}
            />
          </Block>
        </MotionView>
        <MotionView visible={moreOpen && !typing} kind="pop" origin="bottom right" style={styles.morePop}>
          <Block>
            <MoreMenu
              onClose={() => setMoreOpen(false)}
              items={[
                {
                  id: "file",
                  icon: "file-upload-outline",
                  label: "Kirim file ke PC",
                  note: "ke Downloads",
                  onPress: () => {
                    pickAndSend().catch((err) => Alert.alert("Kirim file", String(err?.message || err)));
                  },
                },
                { id: "bar", icon: "gesture-swipe-vertical", label: "Bar scroll", on: bar, onPress: () => setSel({ bar: !bar }) },
                camTools && { id: "aim", icon: "crosshairs", label: "Bidik presisi", on: reticle, onPress: () => setReticle((v) => !v) },
                { id: "fold", icon: fold ? "chevron-up" : "chevron-down", label: fold ? "Tampilkan kontrol" : "Lipat kontrol", on: fold, onPress: () => setSel({ fold: !fold }) },
              ]}
            />
          </Block>
        </MotionView>
      </View>
      {!full && !typing && (
        <Toolbar
          items={[
            // Mode stays on the toolbar (used all the time): one tap switches
            // Klik <-> Lihat; icon + label show the active mode.
            {
              id: "mode",
              icon: looking ? "eye-outline" : "cursor-default-click-outline",
              label: looking ? "Lihat" : `Klik · ${CLICK_BTNS.find((b) => b.id === clickBtn)?.label || "L"}`,
              onPress: () => setSel({ mode: looking ? "Click" : "Look" }),
              onMenu: () => {
                setMoreOpen(false);
                setMonOpen(false);
                setClickOpen((v) => !v);
              },
            },
            // One Zoom / Pas layar toggle: at Fit it opens/closes the zoom
            // slider; once zoomed (or in single-window mode) it fits back.
            camTools &&
              (zoomed || win
                ? {
                    id: "zoom",
                    icon: "fit-to-screen-outline",
                    label: "Pas layar",
                    on: true,
                    onPress: () => {
                      setZoomOpen(false);
                      if (win) winStream.exit();
                      else resetCrop();
                    },
                  }
                : {
                    id: "zoom",
                    icon: "magnify-plus-outline",
                    label: "Zoom",
                    on: zoomOpen,
                    onPress: () => setZoomOpen((v) => !v),
                  }),
            camTools && { id: "win", icon: "application-outline", label: "Jendela", on: thumbs || !!win, onPress: () => setSel({ thumbs: !thumbs }) },
            camTools && { id: "full", icon: "fullscreen", label: "Penuh", onPress: toggleFull },
            {
              id: "more",
              icon: "dots-horizontal",
              label: "Lainnya",
              // Lit while a tool from the menu is active, so it is never "lost".
              on: moreOpen || bar || reticle || fold,
              onPress: () => {
                setMonOpen(false);
                setClickOpen(false);
                setMoreOpen((v) => !v);
              },
            },
          ]}
        />
      )}
      {!full && !typing && (!fold || thumbsOn) && (
      <View style={styles.controls}>
      {thumbsOn ? (
        // Jendela (B): the window list takes the control area, the stream stays clear.
        <WindowThumbBar
          panel
          activeId={win?.id ?? null}
          onClose={() => setSel({ thumbs: false })}
          onFocus={(w) => {
            // In single-window mode the camera follows the new window too.
            if (win) winStream.pickWindow(w);
            else send(msg.winAct(w.id, "focus"));
          }}
          onStream={(w) => {
            winStream.pickWindow(w);
            setSel({ thumbs: false });
          }}
        />
      ) : (
      <>
      {actions && (
        <View style={styles.btnRow}>
          <PressScale onPress={() => send(msg.click("left", true, true))} style={styles.btn} accessibilityLabel="Klik kiri">
            <Text style={styles.btnText}>Kiri</Text>
          </PressScale>
          <PressScale onPress={() => send(msg.click("middle", true, true))} style={[styles.btn, styles.btnMid]} accessibilityLabel="Klik tengah">
            <MaterialCommunityIcons name="mouse" size={20} color={COLORS.muted} />
          </PressScale>
          <PressScale onPress={() => send(msg.click("right", true, true))} style={styles.btn} accessibilityLabel="Klik kanan">
            <Text style={styles.btnText}>Kanan</Text>
          </PressScale>
        </View>
      )}
      {touchpad && (
        <View style={styles.padCard}>
          <View style={styles.pad} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onPadCancel}>
            <Pressable
              onPress={toggleDrag}
              onTouchStart={() => {
                padSkip.current = true;
              }}
              hitSlop={6}
              style={[styles.dragBtn, dragOn && styles.dragBtnOn]}
              accessibilityLabel={dragOn ? "Lepas drag" : "Mulai drag"}
            >
              <MaterialCommunityIcons name="hand-back-right-outline" size={15} color={dragOn ? "#ffffff" : COLORS.text} />
              <Text style={[styles.dragText, dragOn && styles.dragTextOn]}>
                {dragOn ? "Lepas" : clickBtn === "right" ? "Drag R" : clickBtn === "middle" ? "Drag M" : "Drag"}
              </Text>
            </Pressable>
            <Text style={styles.padText} numberOfLines={2}>
              {dragOn
                ? "Drag aktif: geser untuk menyeret, tap Lepas untuk selesai"
                : "Geser = gerak · 2 jari = scroll · Tap = klik · Tap 2 jari = klik kanan"}
            </Text>
          </View>
        </View>
      )}
      {children}
      </>
      )}
      </View>
      )}
    </View>
    </LayoutAnimationConfig>
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
  fpsPill: { position: "absolute", top: 6, right: 6, maxWidth: "75%", backgroundColor: "rgba(18,18,20,0.8)", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 6 },
  fpsStats: { flexShrink: 1 },
  fpsSound: { paddingLeft: 6, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: "rgba(255,255,255,0.25)" },
  streamPop: { position: "absolute", top: 4, left: 0, right: 0 },
  clickSeg: { position: "absolute", left: 6, bottom: 6, flexDirection: "row", gap: 4, backgroundColor: "rgba(22,22,24,0.7)", borderRadius: 999, padding: 3 },
  clickSegBtn: { width: 34, height: 26, borderRadius: 999, backgroundColor: "rgba(44,44,48,0.9)", alignItems: "center", justifyContent: "center" },
  shiftForBar: { left: BAR_W + 4 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6, height: TOOLBAR_H, paddingHorizontal: 8, marginBottom: 6 },
  tbBtn: { flex: 1, minWidth: 0, height: TOOLBAR_H, paddingHorizontal: 2, borderRadius: 10, backgroundColor: COLORS.card, alignItems: "center", justifyContent: "center", gap: 2 },
  tbBtnOn: { backgroundColor: "rgba(94,92,230,0.22)" },
  tbBtnPressed: { opacity: 0.7 },
  tbLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "600" },
  tbLabelOn: { color: COLORS.accent, fontWeight: "700" },
  morePop: { position: "absolute", right: 0, bottom: 6, width: 220 },
  clickPop: { position: "absolute", left: 0, bottom: 6, width: 230 },
  tbIconRow: { flexDirection: "row", alignItems: "center", gap: 0 },
  miniCorner: { position: "absolute", left: 6, top: 6 },
  aimWrap: { alignSelf: "flex-start" },
  moreBox: { backgroundColor: "rgba(28,28,31,0.97)", borderRadius: 14, borderWidth: 1, borderColor: "#3a3a3e", padding: 6, gap: 2 },
  moreItem: { flexDirection: "row", alignItems: "center", gap: 10, height: 44, paddingHorizontal: 10, borderRadius: 10 },
  moreItemOn: { backgroundColor: "rgba(94,92,230,0.22)" },
  moreText: { color: COLORS.text, fontSize: 13, fontWeight: "600", flex: 1 },
  moreNote: { color: COLORS.muted, fontSize: 10 },
  monPick: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingLeft: 10, paddingRight: 6, borderRadius: 14, backgroundColor: COLORS.chip, maxWidth: 130 },
  monPickText: { color: COLORS.text, fontSize: 12, fontWeight: "700", flexShrink: 1 },
  monPop: { position: "absolute", left: 0, top: 4 },
  monBox: { backgroundColor: "rgba(28,28,31,0.97)", borderRadius: 14, borderWidth: 1, borderColor: "#3a3a3e", padding: 8, maxWidth: 300 },
  popStats: { backgroundColor: COLORS.card, borderRadius: 12, marginHorizontal: 8, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 8 },
  controls: { height: CONTROL_H, paddingHorizontal: 8, paddingBottom: CONTROL_PAD, gap: CONTROL_GAP, overflow: "hidden" },
  modes: { flexDirection: "row", alignItems: "center", gap: 4 },
  subTab: { backgroundColor: COLORS.chip, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10 },
  subTabActive: { backgroundColor: "#5e5ce6" },
  subText: { color: COLORS.muted, fontWeight: "700" },
  subTextActive: { color: COLORS.text },
  hint: { color: "#e5e5ea", fontSize: 11, fontWeight: "700" },
  transferWrap: { position: "absolute", left: 8, right: 8, top: 36 },
  clipChip: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(94,92,230,0.92)", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  clipChipText: { color: "#ffffff", fontSize: 11, fontWeight: "700" },
  hintPill: { alignSelf: "flex-start", backgroundColor: "rgba(22,22,24,0.8)", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  overlayTop: { position: "absolute", left: 6, right: 6, top: 32, gap: 4 },
  stalled: { backgroundColor: "rgba(127,29,29,0.9)", borderRadius: 8, padding: 8 },
  stalledText: { color: "#f2f2f5", fontSize: 12, fontWeight: "700", textAlign: "center" },
  blocked: { backgroundColor: "rgba(44,44,48,0.9)", borderRadius: 8, padding: 6 },
  blockedText: { color: COLORS.muted, fontSize: 11, fontWeight: "700", textAlign: "center" },
  clickBtn: { flex: 1, backgroundColor: COLORS.chip, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  clickBtnActive: { backgroundColor: "#7c7aff" },
  clickText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  clickTextActive: { color: "#ffffff" },
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
    borderColor: "#7c7aff",
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  ringLocal: { borderColor: "#ff9f0a" },
  ringHidden: { borderStyle: "dashed", borderColor: "rgba(124,122,255,0.45)" },
  ringIcon: { textShadowColor: "#000", textShadowRadius: 3 },
  localChip: { position: "absolute", left: 8, bottom: 8, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(28,28,31,0.92)", borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,159,10,0.6)", paddingVertical: 4, paddingHorizontal: 9 },
  localChipText: { color: "#ff9f0a", fontSize: 11, fontWeight: "600" },
  lookBar: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 6, gap: 6 },
  rulerWrap: { position: "absolute", left: 0, right: 0, bottom: 8, alignItems: "center", gap: 6 },
  rulerValue: { height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: "#facc15", alignItems: "center", justifyContent: "center" },
  rulerValueText: { color: "#1c1400", fontSize: 13, fontWeight: "800" },
  ruler: { width: RULER_W, height: 48, borderRadius: 24, backgroundColor: "rgba(18,18,20,0.9)", borderWidth: 1, borderColor: "rgba(255,255,255,0.13)", overflow: "hidden" },
  tape: { position: "absolute", left: 0, top: 0, bottom: 0, width: RULER_UNIT * LOG_MAX + 2 },
  rTick: { position: "absolute", top: 17, width: 2, height: 9, marginLeft: -1, borderRadius: 1, backgroundColor: "rgba(255,255,255,0.35)" },
  rTickBig: { top: 9, height: 17, backgroundColor: "rgba(255,255,255,0.85)" },
  rLabel: { position: "absolute", top: 29, width: 24, textAlign: "center", color: "rgba(255,255,255,0.7)", fontSize: 10, fontWeight: "700" },
  needle: { position: "absolute", left: RULER_W / 2 - 1.5, top: 4, bottom: 4, width: 3, borderRadius: 2, backgroundColor: "#facc15" },
  toolRow: { position: "absolute", left: 6, top: 6, flexDirection: "row", alignItems: "center", gap: 4 },
  toolBtn: { width: 30, height: 26, borderRadius: 999, backgroundColor: "rgba(22,22,24,0.8)", alignItems: "center", justifyContent: "center" },
  toolBtnOn: { backgroundColor: "#5e5ce6", borderWidth: 1, borderColor: "#7c7aff" },
  toolText: { color: "#e5e5ea", fontSize: 13, fontWeight: "800" },
  toolTextOn: { color: "#a5a1ff" },
  sharpPill: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(22,22,24,0.7)", borderRadius: 999, paddingVertical: 3, paddingHorizontal: 7 },
  sharpDot: { width: 7, height: 7, borderRadius: 4 },
  sharpText: { color: "#d1d1d6", fontSize: 9, fontWeight: "800" },
  clickSegInline: { flexDirection: "row", gap: 3, backgroundColor: "rgba(22,22,24,0.7)", borderRadius: 999, padding: 3 },
  aimBtn: { backgroundColor: "#7c7aff", borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  aimText: { color: "#ffffff", fontWeight: "900", fontSize: 12 },
  reticle: { position: "absolute", left: "50%", top: "50%", width: 40, height: 40, marginLeft: -20, marginTop: -20 },
  retLine: { position: "absolute", backgroundColor: "#fff", borderRadius: 1, shadowColor: "#000", shadowOpacity: 0.8, shadowRadius: 2, elevation: 2 },
  retDot: { position: "absolute", left: 17, top: 17, width: 6, height: 6, borderRadius: 3, backgroundColor: "#ef4444" },
  viewerBoxFull: { marginHorizontal: 0, marginBottom: 0 },
  lookBottom: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "flex-end" },
  zoomRowScroll: { flexGrow: 1, alignItems: "center" },
  caretBadge: { position: "absolute", top: 6, right: 6, backgroundColor: "rgba(15,23,42,0.75)", borderRadius: 8, paddingVertical: 2, paddingHorizontal: 8 },
  caretBadgeText: { color: "#e2e8f0", fontSize: 11, fontWeight: "700" },
  zoomBadge: { backgroundColor: "rgba(124,45,18,0.9)", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 12 },
  zoomBadgeText: { color: "#fed7aa", fontWeight: "800", fontSize: 12 },
  minimap: { backgroundColor: "rgba(22,22,24,0.85)", borderRadius: 6, borderWidth: 1, borderColor: "#3a3a3e", overflow: "hidden" },
  viewport: { position: "absolute", borderWidth: 2, borderColor: "#7c7aff", backgroundColor: "rgba(124,122,255,0.18)" },
  bar: { position: "absolute", left: 0, top: 0, bottom: 0, width: BAR_W },
  thumbWrap: { position: "absolute", left: 6, right: 6, bottom: 6 },
  error: { color: COLORS.danger, paddingHorizontal: 8, textAlign: "center", fontSize: 12 },
  btnRow: { flexDirection: "row", gap: 6, height: PAD_BTN_H },
  btn: { flex: 1, backgroundColor: COLORS.chip, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnMid: { flex: 0, width: 52 },
  btnText: { color: COLORS.text, fontWeight: "700", fontSize: 14 },
  padCard: { flex: 1, flexDirection: "row", gap: 6, padding: 6, borderRadius: 14, backgroundColor: COLORS.card, borderWidth: StyleSheet.hairlineWidth, borderColor: "#3a3a3e" },
  pad: { flex: 1, overflow: "hidden", justifyContent: "space-between", padding: 2 },
  padText: { color: COLORS.muted, fontSize: 11, paddingLeft: 4 },
  dragBtn: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: COLORS.chip },
  dragBtnOn: { backgroundColor: COLORS.fill, borderWidth: 1, borderColor: COLORS.accent },
  dragText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  dragTextOn: { color: "#ffffff" },
  lagWrap: { position: "absolute", left: 8, right: 64, top: 36 },
  lagBelowWin: { top: 74 },
  winWrap: { position: "absolute", left: 8, right: 64, top: 34 },
});
