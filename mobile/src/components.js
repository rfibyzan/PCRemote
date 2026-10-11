/** Shared presentational components: monitor chips, screen views. */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { bytesToBase64 } from "./protocol";
import { releaseScreenHandler, setScreenHandler } from "./connection";
import { trackDropped } from "./cursor";

export const COLORS = {
  bg: "#0b1220",
  card: "#151d2e",
  chip: "#1e293b",
  accent: "#7dd3fc",
  text: "#e8eefc",
  muted: "#94a3b8",
  ok: "#4ade80",
  danger: "#f87171",
};

/** Source selector: All | 1..n (primary marked *) | Cam.
 * `row` renders non-wrapping for embedding in a horizontal scroll strip. */
export function MonitorChips({ monitors, current, onPick, row }) {
  return (
    <View style={[styles.chips, row && styles.chipsRow]}>
      <Pressable onPress={() => onPick("all")} style={[styles.chip, String(current) === "all" && styles.chipActive]}>
        <Text style={[styles.chipText, String(current) === "all" && styles.chipTextActive]}>All</Text>
      </Pressable>
      {(monitors || []).map((m, i) => {
        const active = String(current) === String(m.id);
        const n = Number(m.id);
        const label = `${Number.isFinite(n) ? n + 1 : i + 1}${m.primary ? "*" : ""}`;
        return (
          <Pressable key={String(m.id)} onPress={() => onPick(m.id)} style={[styles.chip, active && styles.chipActive]}>
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
      <Pressable onPress={() => onPick("cam")} style={[styles.chip, String(current) === "cam" && styles.chipActive]}>
        <Text style={[styles.chipText, String(current) === "cam" && styles.chipTextActive]}>Cam</Text>
      </Pressable>
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

export function ScreenView({ style, imageStyle, onFrame, monKey }) {
  const keyFor = (k) => (k === undefined || k === null ? "all" : String(k));
  const [uris, setUris] = useState(() => [_lastByMon[keyFor(monKey)]?.uri || null, null]);
  const [front, setFront] = useState(0);
  const frontRef = useRef(0);
  const seqRef = useRef(0);
  const slotSeqRef = useRef([0, 0]);
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;

  // Stable handler: only refs + setUris, so focus re-registration is safe.
  // Backpressure: enqueue at most ~15fps into the Image decoder. Faster
  // streams (22fps setting) would otherwise churn giant base64 strings on
  // the JS thread and freeze the app after minutes. Dropped frames are
  // counted for stats; the visible frame is never blanked. Dropped frames
  // are marked _dropped so meters count DISPLAYED frames only (honest real
  // fps) while cursor/size metadata still flows.
  const lastEnqueueAt = useRef(0);
  const pendingDecode = useRef(false);
  const monKeyRef = useRef(monKey);
  monKeyRef.current = monKey;
  const handlerRef = useRef(null);
  if (!handlerRef.current) {
    handlerRef.current = (frame) => {
      if (!frame?.jpeg?.length) return; // keep last valid frame
      const now = Date.now();
      // If a decode is still pending and we enqueued very recently, drop:
      // the decoder is behind, showing an older frame longer is smoother
      // than queuing base64 churn that freezes the app.
      if (pendingDecode.current && now - lastEnqueueAt.current < 120) {
        trackDropped();
        try {
          cbRef.current?.({ ...frame, _dropped: true });
        } catch {
          // metadata consumers must not break rendering
        }
        return;
      }
      if (now - lastEnqueueAt.current < 45) {
        // Over cap: metadata flows, display + meters skip this one.
        try {
          cbRef.current?.({ ...frame, _dropped: true });
        } catch {
          // metadata consumers must not break rendering
        }
        return;
      }
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
      const entry = { uri: next, meta: frame };
      _lastByMon[_monKeyOf(frame)] = entry;
      _lastAny = entry;
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
        try {
          if (held.meta) cbRef.current?.(held.meta);
        } catch {
          // metadata consumers must not break rendering
        }
      }
      return () => releaseScreenHandler(handlerRef.current);
    }, []),
  );

  function onLoad(slot) {
    // Swap only for the newest issued frame; ignore stale decodes.
    pendingDecode.current = false;
    if (slotSeqRef.current[slot] === seqRef.current && frontRef.current !== slot) {
      frontRef.current = slot;
      setFront(slot);
    }
  }

  function onError() {
    pendingDecode.current = false;
    // keep last valid frame; next frame will retry
  }

  const ready = uris[0] || uris[1];
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
  chipActive: { backgroundColor: "#0c4a6e" },
  chipText: { color: COLORS.muted, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: COLORS.text },
  screen: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  layer: { position: "absolute", left: 0, top: 0 },
  waiting: { color: COLORS.muted },
});
