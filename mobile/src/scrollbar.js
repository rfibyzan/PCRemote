/** Scroll direction/speed preference + the Bar scroll strip.
 *
 * One preference (pcremote.scroll, SecureStore) drives BOTH the Bar strip and
 * two-finger scroll on the touchpad. Default = natural (content follows the
 * finger, like a phone); "Terbalik" = old mouse-wheel feel.
 *
 * BarScroll keeps its own state (thumb, notch pill) so a drag never
 * re-renders the whole ViewerPanel.
 */
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import * as SecureStore from "expo-secure-store";
import { COLORS } from "./components";
import { STORE_SCROLL, msg } from "./protocol";
import { send } from "./connection";
import { FLING_MIN, SPEEDS, clampThumb, flingStep, makeNotchCounter, normScroll, wheelFromSwipe } from "./scrollmath";

// ---- preference store -------------------------------------------------------
let pref = normScroll(null);
const listeners = new Set();
let loaded = false;

function emit() {
  for (const l of listeners) l(pref);
}

async function loadPref() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await SecureStore.getItemAsync(STORE_SCROLL);
    if (raw) {
      pref = normScroll(JSON.parse(raw));
      emit();
    }
  } catch {
    // keep defaults
  }
}

export function getScrollPref() {
  return pref;
}

export function setScrollPref(patch) {
  pref = normScroll({ ...pref, ...patch });
  emit();
  SecureStore.setItemAsync(STORE_SCROLL, JSON.stringify(pref)).catch(() => {});
}

export function useScrollPref() {
  const [p, setP] = useState(pref);
  useEffect(() => {
    listeners.add(setP);
    loadPref();
    setP(pref);
    return () => listeners.delete(setP);
  }, []);
  return p;
}

/** Touchpad two-finger scroll (finger delta already scaled by the caller). */
export function sendSwipeScroll(dx, dy, gain = 1) {
  const w = wheelFromSwipe(dx, dy, pref, gain);
  if (w.dx || w.dy) send(msg.scroll(w.dx, w.dy));
}

// ---- Bar strip ----------------------------------------------------------------
const BAR_GAIN = 5; // wheel units per px at speed 1 (same feel as before)
const THUMB_H = 56;
const BTN_STEP = 240; // ▲ / ▼ = two notches, always page up / page down

export function BarScroll() {
  useScrollPref(); // load early; reads use getScrollPref()
  const thumbY = useSharedValue(0);
  const trackH = useRef(0);
  const drag = useRef(null);
  const fling = useRef(null);
  const notches = useRef(makeNotchCounter());
  const pillTimer = useRef(null);
  const [pill, setPill] = useState(0); // signed notch count shown while scrolling

  useEffect(
    () => () => {
      stopFling();
      if (pillTimer.current) clearTimeout(pillTimer.current);
    },
    [],
  );

  function stopFling() {
    if (fling.current) {
      clearInterval(fling.current);
      fling.current = null;
    }
  }

  function bumpPill(n) {
    if (!n) return;
    setPill((v) => (Math.sign(v) === Math.sign(n) ? v + n : n));
    if (pillTimer.current) clearTimeout(pillTimer.current);
    pillTimer.current = setTimeout(() => setPill(0), 900);
  }

  function wheel(dyFinger, haptic) {
    const w = wheelFromSwipe(0, dyFinger, getScrollPref(), BAR_GAIN);
    if (!w.dy) return;
    send(msg.scroll(0, w.dy));
    const n = notches.current.add(w.dy);
    if (n) {
      bumpPill(n);
      if (haptic) Vibration.vibrate(6);
    }
  }

  function onStart(e) {
    stopFling();
    notches.current.reset();
    const t = e.nativeEvent.touches?.[0];
    const y = t ? t.pageY : 0;
    drag.current = { y0: y, y, t: Date.now(), v: 0 };
  }

  function onMove(e) {
    const st = drag.current;
    const t = e.nativeEvent.touches?.[0];
    if (!st || !t) return;
    const dy = t.pageY - st.y;
    const now = Date.now();
    const dt = Math.max(1, now - st.t);
    st.v = st.v * 0.6 + (dy / dt) * 0.4; // smoothed px/ms
    st.y = t.pageY;
    st.t = now;
    thumbY.value = clampThumb(t.pageY - st.y0, trackH.current, THUMB_H);
    if (dy) wheel(dy, true);
  }

  function onEnd() {
    const st = drag.current;
    drag.current = null;
    thumbY.value = withSpring(0, { damping: 14, stiffness: 180 });
    if (!st || Date.now() - st.t > 80 || Math.abs(st.v) < FLING_MIN) return;
    let v = st.v;
    stopFling();
    const started = Date.now();
    fling.current = setInterval(() => {
      v = flingStep(v, 16);
      if (!v || Date.now() - started > 1500) {
        stopFling();
        return;
      }
      wheel(v * 16, false);
    }, 16);
  }

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateY: thumbY.value }] }));
  const down = pill < 0; // negative wheel = view moves down the page

  return (
    <View style={styles.wrap}>
      <View style={styles.strip}>
        <Pressable onPress={() => send(msg.scroll(0, BTN_STEP))} style={styles.btn} hitSlop={4} accessibilityLabel="Scroll ke atas">
          <Text style={styles.btnText}>▲</Text>
        </Pressable>
        <View
          style={styles.track}
          onLayout={(e) => (trackH.current = e.nativeEvent.layout.height)}
          onTouchStart={onStart}
          onTouchMove={onMove}
          onTouchEnd={onEnd}
          onTouchCancel={onEnd}
        >
          <View style={styles.ticks} pointerEvents="none">
            {Array.from({ length: 11 }).map((_, i) => (
              <View key={i} style={styles.tick} />
            ))}
          </View>
          <View style={styles.home} pointerEvents="none" />
          <Reanimated.View style={[styles.thumb, thumbStyle]} pointerEvents="none">
            <View style={styles.grip} />
            <View style={styles.grip} />
            <View style={styles.grip} />
          </Reanimated.View>
        </View>
        <Pressable onPress={() => send(msg.scroll(0, -BTN_STEP))} style={styles.btn} hitSlop={4} accessibilityLabel="Scroll ke bawah">
          <Text style={styles.btnText}>▼</Text>
        </Pressable>
      </View>
      {pill !== 0 && (
        <View style={styles.pill} pointerEvents="none">
          <Text style={styles.pillText}>
            {Math.abs(pill)} notch ke {down ? "bawah" : "atas"}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---- settings (inside the ⚙ stream popover) ---------------------------------
export function ScrollSettings() {
  const p = useScrollPref();
  return (
    <View style={styles.set}>
      <Text style={styles.setHead}>SCROLL (BAR & 2 JARI)</Text>
      <View style={styles.setRow}>
        <Text style={styles.setLabel}>Arah</Text>
        <View style={styles.seg}>
          {[
            ["Natural", true],
            ["Terbalik", false],
          ].map(([label, nat]) => (
            <Pressable key={label} onPress={() => setScrollPref({ natural: nat })} style={[styles.segBtn, p.natural === nat && styles.segOn]} hitSlop={3}>
              <Text style={[styles.segText, p.natural === nat && styles.segTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Text style={styles.setNote}>
        {p.natural ? "Geser ke atas = isi naik (seperti HP)" : "Geser ke atas = halaman naik (seperti roda mouse)"}
      </Text>
      <View style={styles.setRow}>
        <Text style={styles.setLabel}>Kecepatan</Text>
        <View style={styles.speedRow}>
          {SPEEDS.map((s, i) => (
            <Pressable key={s} onPress={() => setScrollPref({ speed: i })} style={[styles.speedBtn, i <= p.speed && styles.speedOn]} hitSlop={3} accessibilityLabel={`Kecepatan ${s}x`} />
          ))}
        </View>
        <Text style={styles.speedText}>{SPEEDS[p.speed]}x</Text>
      </View>
    </View>
  );
}

export const BAR_W = 52;

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  strip: {
    position: "absolute",
    left: 2,
    top: 4,
    bottom: 4,
    width: BAR_W - 4,
    borderRadius: 14,
    backgroundColor: "rgba(15,23,42,0.85)",
    borderWidth: 1,
    borderColor: "#334155",
    padding: 4,
    alignItems: "center",
  },
  btn: { width: 40, height: 44, borderRadius: 10, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  btnText: { color: COLORS.text, fontWeight: "800", fontSize: 16 },
  track: { flex: 1, width: 40, marginVertical: 6, borderRadius: 14, backgroundColor: "rgba(30,41,59,0.7)", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  ticks: { ...StyleSheet.absoluteFillObject, justifyContent: "space-evenly", alignItems: "center" },
  tick: { width: 12, height: 1, backgroundColor: "#334155" },
  home: { position: "absolute", width: 30, height: THUMB_H, borderRadius: 14, borderWidth: 1, borderColor: "#475569" },
  thumb: { width: 32, height: THUMB_H, borderRadius: 16, backgroundColor: COLORS.accent, alignItems: "center", justifyContent: "center", gap: 5 },
  grip: { width: 14, height: 2, borderRadius: 1, backgroundColor: COLORS.bg },
  pill: { position: "absolute", left: BAR_W + 6, bottom: 10, backgroundColor: "rgba(15,23,42,0.88)", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  pillText: { color: COLORS.accent, fontSize: 11, fontWeight: "800" },
  set: { marginTop: 6, backgroundColor: COLORS.card, borderRadius: 12, padding: 10, gap: 6, borderWidth: 1, borderColor: "#334155" },
  setHead: { color: COLORS.muted, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  setRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  setLabel: { color: COLORS.text, fontSize: 12, fontWeight: "800", width: 72 },
  seg: { flex: 1, flexDirection: "row", backgroundColor: COLORS.chip, borderRadius: 10, padding: 2 },
  segBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: "center" },
  segOn: { backgroundColor: "#0c4a6e" },
  segText: { color: COLORS.muted, fontSize: 12, fontWeight: "800" },
  segTextOn: { color: COLORS.text },
  setNote: { color: COLORS.muted, fontSize: 10, marginLeft: 80 },
  speedRow: { flex: 1, flexDirection: "row", gap: 4 },
  speedBtn: { flex: 1, height: 18, borderRadius: 5, backgroundColor: COLORS.chip },
  speedOn: { backgroundColor: COLORS.accent },
  speedText: { color: COLORS.muted, fontSize: 11, fontWeight: "800", width: 32, textAlign: "right" },
});
