/** Shared presentational components: monitor chips, screen views. */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { PressScale } from "./motion";
import Text from "./AppText";
import { useFocusEffect } from "expo-router";
import { bytesToBase64 } from "./protocol";
import { releaseScreenHandler, setScreenHandler } from "./connection";
import { trackDropped, trackReceived } from "./cursor";

// Neutral greys + one indigo accent (Sill-style, 2026-10-15).
export const COLORS = {
  bg: "#0b0b0d",
  card: "#1c1c1f",
  chip: "#2c2c30",
  fill: "#5e5ce6", // selected button / primary action background
  line: "#3a3a3e",
  accent: "#a5a1ff",
  text: "#f2f2f5",
  muted: "#8e8e93",
  ok: "#34c759",
  danger: "#f87171",
};

/** Source selector: All | 1..n (primary marked *) | Cam.
 * `row` renders non-wrapping for embedding in a horizontal scroll strip. */
export function MonitorChips({ monitors, current, onPick, row }) {
  return (
    <View style={[styles.chips, row && styles.chipsRow]}>
      <PressScale onPress={() => onPick("all")} style={[styles.chip, String(current) === "all" && styles.chipActive]}>
        <Text style={[styles.chipText, String(current) === "all" && styles.chipTextActive]}>All</Text>
      </PressScale>
      {(monitors || []).map((m, i) => {
        const active = String(current) === String(m.id);
        const n = Number(m.id);
        const label = `${Number.isFinite(n) ? n + 1 : i + 1}${m.primary ? "*" : ""}`;
        return (
          <PressScale key={String(m.id)} onPress={() => onPick(m.id)} style={[styles.chip, active && styles.chipActive]}>
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
          </PressScale>
        );
      })}
      <PressScale onPress={() => onPick("cam")} style={[styles.chip, String(current) === "cam" && styles.chipActive]}>
        <Text style={[styles.chipText, String(current) === "cam" && styles.chipTextActive]}>Cam</Text>
      </PressScale>
    </View>
  );
}

/**
 * Last-valid-frame screen renderer (double-buffered).
 *
 * Flicker mechanism this fixes: with a single <Image>, every PR frame
 * replaces source.uri, so the native view drops the current drawable and
 * goes EMPTY (black) while the new full-screen JPEG decodes — visible as
 * black flashing at streaming fps, worse under software decode.
 *
 * Two stacked Images with stable identity (never unmounted, never keyed):
 * new valid frames preload into the HIDDEN layer; its onLoad (guarded by a
 * sequence token so stale decodes can't win) swaps opacity. The visible
 * layer is therefore never blank: invalid frames are ignored and the last
 * valid frame stays up until the next one is fully decoded.
 * Only this component re-renders per frame; siblings (e.g. the GAME
 * controller overlay) are untouched. The VISIBLE viewer always owns the
 * single screen-handler slot: registration happens on mount AND on tab
 * focus (re-asserting the screen subscription), released on blur/unmount,
 * so tab switching can never starve the visible viewer.
 * Handoff buffer: the last decoded frame URI is kept module-global PER
 * MONITOR so a newly focused tab shows something instantly instead of
 * "Waiting…", and never flashes another monitor's content.
 */
const _lastByMon = {};
let _lastAny = null;

function _monKeyOf(frame) {
  const m = frame?.mon;
  return m === undefined || m === null ? "all" : String(m);
}

const _lastFullByMon = {};
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

function _isFull(c) {
  return !c || (c.w >= 0.995 && c.h >= 0.995);
}

/**
 * `placed` (Look camera canvas): each layer is drawn at the monitor rect its
 * own frame covers (header crop, snapped to the exact sent crop through
 * `resolveCrop`), stretched to fill it. The last whole-monitor frame stays
 * underneath as a backdrop, so a pan past the sharp region shows slightly
 * older pixels instead of black while the new region is on its way.
 */
// Newest whole-monitor frame of a monitor (minimap thumbnail in the viewer).
export function getLastFullFrame(monKey) {
  const k = monKey === undefined || monKey === null ? "all" : String(monKey);
  return _lastFullByMon[k] || _lastByMon[k]?.uri || null;
}

export function ScreenView({ style, imageStyle, onFrame, monKey, placed = false, resolveCrop = null }) {
  const keyFor = (k) => (k === undefined || k === null ? "all" : String(k));
  const [uris, setUris] = useState(() => [_lastByMon[keyFor(monKey)]?.uri || null, null]);
  // Monitor rect each slot shows (placed mode only).
  const [crops, setCrops] = useState(() => [_lastByMon[keyFor(monKey)]?.crop || FULL_CROP, FULL_CROP]);
  const [overview, setOverview] = useState(() => _lastFullByMon[keyFor(monKey)] || null);
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const resolveRef = useRef(resolveCrop);
  resolveRef.current = resolveCrop;
  const [front, setFront] = useState(0);
  const frontRef = useRef(0);
  const seqRef = useRef(0);
  const slotSeqRef = useRef([0, 0]);
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;

  // Stable handler: only refs + setUris, so focus re-registration is safe.
  // Backpressure, latest-wins: at most ONE frame is decoding in the Image
  // layer. A frame that arrives meanwhile is parked (replacing any older
  // parked frame, which counts as dropped) and is shown the moment the decode
  // finishes. The old rule dropped every frame that arrived within 120 ms of
  // an enqueue, so after each decode the viewer sat idle until the NEXT frame
  // came in: on a 19 fps stream that alone cut displayed fps to ~6.
  // Frames marked _dropped still flow for cursor/size metadata, while meters
  // count DISPLAYED frames only (honest real fps).
  const lastEnqueueAt = useRef(0);
  const pendingDecode = useRef(false);
  const parkedRef = useRef(null);
  const monKeyRef = useRef(monKey);
  monKeyRef.current = monKey;
  const handlerRef = useRef(null);
  const presentRef = useRef(null);
  if (!handlerRef.current) {
    handlerRef.current = (frame) => {
      if (!frame?.jpeg?.length) return; // keep last valid frame
      trackReceived();
      // A decode that never reports back (rare onLoad loss) must not wedge
      // the viewer: after 400 ms treat it as finished.
      if (pendingDecode.current && Date.now() - lastEnqueueAt.current < 400) {
        const old = parkedRef.current;
        parkedRef.current = frame;
        if (old) {
          trackDropped();
          try {
            cbRef.current?.({ ...old, _dropped: true });
          } catch {
            // metadata consumers must not break rendering
          }
        }
        return;
      }
      presentRef.current(frame);
    };
    presentRef.current = (frame) => {
      const now = Date.now();
      try {
        cbRef.current?.(frame);
      } catch {
        // metadata consumers must not break rendering
      }
      let next;
      try {
        next = `data:image/jpeg;base64,${bytesToBase64(frame.jpeg)}`;
      } catch {
        return; // keep last valid frame
      }
      const hidden = 1 - frontRef.current;
      const seq = ++seqRef.current;
      slotSeqRef.current[hidden] = seq;
      lastEnqueueAt.current = now;
      pendingDecode.current = true;
      let crop = FULL_CROP;
      try {
        crop = resolveRef.current ? resolveRef.current(frame.crop) : frame.crop || FULL_CROP;
      } catch {
        crop = frame.crop || FULL_CROP;
      }
      const mk = _monKeyOf(frame);
      const entry = { uri: next, meta: frame, crop };
      _lastByMon[mk] = entry;
      _lastAny = entry;
      if (_isFull(crop)) _lastFullByMon[mk] = next;
      else if (placedRef.current) {
        // Zoomed in: freeze the newest whole-monitor frame as the backdrop.
        const ov = _lastFullByMon[mk] || null;
        setOverview((prev) => (prev === ov ? prev : ov));
      }
      setCrops((prev) => {
        const p = prev[hidden];
        if (p && p.x === crop.x && p.y === crop.y && p.w === crop.w && p.h === crop.h) return prev;
        const copy = [...prev];
        copy[hidden] = crop;
        return copy;
      });
      setUris((prev) => {
        if (prev[hidden] === next) {
          pendingDecode.current = false;
          return prev;
        }
        const copy = [...prev];
        copy[hidden] = next;
        return copy;
      });
    };
  }

  useEffect(() => {
    setScreenHandler(handlerRef.current);
    return () => releaseScreenHandler(handlerRef.current);
  }, []);

  // Tabs stay mounted in the background: the focused tab's viewer must own
  // the single handler slot, or frames flow to a hidden viewer while the
  // visible one shows "Waiting…" forever. On handoff, instantly show the
  // last frame OF THE SAME MONITOR (already decoded) so there is never a
  // black gap nor a flash of another monitor's content.
  // Release is ownership-guarded: if the incoming tab already registered
  // itself before this blur runs, we must not steal its slot (that sent a
  // stray screen(false) and froze the new tab with no watchdog on GAME).
  useFocusEffect(
    useCallback(() => {
      setScreenHandler(handlerRef.current);
      const provided = monKeyRef.current !== undefined && monKeyRef.current !== null;
      const k = provided ? String(monKeyRef.current) : "all";
      // Same-monitor preferred; callers without a key (GAME fullscreen) take
      // the most recent frame of any monitor.
      const held = _lastByMon[k] || (!provided ? _lastAny : null);
      if (held?.uri) {
        const seq = ++seqRef.current;
        slotSeqRef.current[0] = seq;
        frontRef.current = 0;
        setFront(0);
        setUris((prev) => (prev[0] === held.uri ? prev : [held.uri, prev[1]]));
        setCrops((prev) => [held.crop || FULL_CROP, prev[1]]);
        setOverview(_lastFullByMon[k] || null);
        try {
          if (held.meta) cbRef.current?.(held.meta);
        } catch {
          // metadata consumers must not break rendering
        }
      }
      return () => releaseScreenHandler(handlerRef.current);
    }, []),
  );

  // Decode finished (or failed): show the parked frame right away.
  function drainParked() {
    const parked = parkedRef.current;
    if (!parked) return;
    parkedRef.current = null;
    presentRef.current(parked);
  }

  function onLoad(slot) {
    // Swap only for the newest issued frame; ignore stale decodes.
    pendingDecode.current = false;
    if (slotSeqRef.current[slot] === seqRef.current && frontRef.current !== slot) {
      frontRef.current = slot;
      setFront(slot);
    }
    drainParked();
  }

  function onError() {
    pendingDecode.current = false;
    drainParked();
    // keep last valid frame; next frame will retry
  }

  const ready = uris[0] || uris[1];
  if (placed) {
    // Camera canvas: layers sit at their own monitor rect. Newest decoded
    // frame on top, whole-monitor backdrop at the bottom.
    const rectStyle = (c) => ({
      position: "absolute",
      left: `${(c.x * 100).toFixed(3)}%`,
      top: `${(c.y * 100).toFixed(3)}%`,
      width: `${(c.w * 100).toFixed(3)}%`,
      height: `${(c.h * 100).toFixed(3)}%`,
    });
    const frontFull = _isFull(crops[front]);
    return (
      <View style={[styles.canvas, style]}>
        {!ready && <Text style={styles.waiting}>Waiting for this monitor…</Text>}
        {!!overview && !frontFull && (
          <Image source={{ uri: overview }} style={[rectStyle(FULL_CROP), { zIndex: 0 }]} resizeMode="stretch" fadeDuration={0} />
        )}
        {[0, 1].map((slot) =>
          uris[slot] ? (
            <Image
              key={slot}
              source={{ uri: uris[slot] }}
              style={[rectStyle(crops[slot] || FULL_CROP), { zIndex: front === slot ? 2 : 1, opacity: front === slot ? 1 : 0 }]}
              resizeMode="stretch"
              fadeDuration={0}
              onLoad={() => onLoad(slot)}
              onError={onError}
            />
          ) : null,
        )}
      </View>
    );
  }
  return (
    <View style={[styles.screen, style]}>
      {!ready && <Text style={styles.waiting}>Waiting for this monitor…</Text>}
      {uris[0] && (
        <Image
          source={{ uri: uris[0] }}
          style={[styles.image, imageStyle, styles.layer, { opacity: front === 0 ? 1 : 0 }]}
          resizeMode="contain"
          fadeDuration={0}
          onLoad={() => onLoad(0)}
          onError={onError}
        />
      )}
      {uris[1] && (
        <Image
          source={{ uri: uris[1] }}
          style={[styles.image, imageStyle, styles.layer, { opacity: front === 1 ? 1 : 0 }]}
          resizeMode="contain"
          fadeDuration={0}
          onLoad={() => onLoad(1)}
          onError={onError}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 8 },
  chipsRow: { flexWrap: "nowrap", padding: 0 },
  chip: { backgroundColor: COLORS.chip, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 8 },
  chipActive: { backgroundColor: "#5e5ce6" },
  chipText: { color: COLORS.muted, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: COLORS.text },
  canvas: { position: "relative", overflow: "hidden" },
  screen: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  layer: { position: "absolute", left: 0, top: 0 },
  waiting: { color: COLORS.muted },
});
