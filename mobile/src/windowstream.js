/**
 * Single-window stream (idea from Sill). The agent lists app windows with
 * their rect normalized to their monitor ({t:"windows"}); picking one focuses
 * it on the PC, switches to its monitor and zooms the viewer camera onto it
 * (camera.js camForRect), so taps, crops and the cursor ring keep working
 * unchanged. While a window is picked the list is re-read every 2 s and the
 * camera follows the window when it moves or resizes.
 */
import React, { useEffect, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Text from "./AppText";
import { COLORS } from "./components";
import { getSel, setSel } from "./controls";
import { msg } from "./protocol";
import { addListener, send } from "./connection";

const POLL_MS = 2000;

/** Same window, same place? (rect within ~0.2% of the monitor) */
export function sameRect(a, b) {
  if (!a || !b) return false;
  const e = 0.002;
  return a.mon === b.mon && Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.w - b.w) < e && Math.abs(a.h - b.h) < e;
}

/** Next picked-window state after a fresh list: same object (no change), updated, or null (gone). */
export function followWindow(win, list) {
  if (!win) return win;
  const hit = (list || []).find((w) => w.id === win.id);
  if (!hit) return null;
  if (hit.min || hit.mon == null) return { ...win, min: true };
  if (!win.min && sameRect(win, hit) && win.title === hit.title) return win;
  return { ...hit, min: false };
}

/**
 * Hook for the viewer. onMonitor(id) switches the stream source; fitTo(rect)
 * frames the camera on a monitor rect; reset() goes back to Fit.
 */
export function useWindowStream({ win, current, onMonitor, fitTo, reset }) {
  const [list, setList] = useState(null);
  const ref = useRef({ win, current, onMonitor, fitTo });
  ref.current = { win, current, onMonitor, fitTo };

  useEffect(() => {
    return addListener((e) => {
      if (e.t !== "windows" || !Array.isArray(e.list)) return;
      setList(e.list);
      const cur = getSel().win;
      if (!cur) return;
      const next = followWindow(cur, e.list);
      if (next !== cur) setSel({ win: next });
    });
  }, []);

  // Poll while a window is picked (it can move, resize, close).
  useEffect(() => {
    if (!win) return undefined;
    const timer = setInterval(() => send(msg.windows()), POLL_MS);
    return () => clearInterval(timer);
  }, [win?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frame the camera on the window once its monitor is showing.
  const key = win && !win.min ? `${win.id}:${win.mon}:${win.x}:${win.y}:${win.w}:${win.h}` : "";
  useEffect(() => {
    const r = ref.current;
    if (!key || !r.win) return undefined;
    if (r.win.mon !== r.current) {
      r.onMonitor(r.win.mon);
      return undefined;
    }
    // Small delay so the monitor's aspect/layout is known after a switch.
    const t = setTimeout(() => ref.current.fitTo(ref.current.win), 80);
    return () => clearTimeout(t);
  }, [key, current]);

  function refresh() {
    send(msg.windows());
  }
  function pickWindow(w) {
    send(msg.winAct(w.id, "focus"));
    setSel({ win: { ...w } });
    // A minimized window gets its rect once restored.
    if (w.min) setTimeout(refresh, 450);
  }
  function exit() {
    setSel({ win: null });
    reset();
  }
  return { list, refresh, pickWindow, exit };
}

function monLabel(mon) {
  return mon == null ? "" : `Layar ${Number(mon) + 1}`;
}

export function WindowPicker({ visible, list, onPick, onRefresh, onClose }) {
  useEffect(() => {
    if (visible) onRefresh();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.shade} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.head}>
            <Text style={styles.headTitle}>Stream satu jendela</Text>
            <Pressable onPress={onRefresh} hitSlop={8} accessibilityLabel="Muat ulang">
              <MaterialCommunityIcons name="refresh" size={20} color={COLORS.text} />
            </Pressable>
          </View>
          <ScrollView style={styles.list}>
            {list == null && <Text style={styles.empty}>Memuat jendela…</Text>}
            {list != null && !list.length && <Text style={styles.empty}>Tidak ada jendela. Perbarui agent PC kalau ini terus kosong.</Text>}
            {(list || []).map((w) => (
              <Pressable key={w.id} onPress={() => onPick(w)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <MaterialCommunityIcons name="application-outline" size={20} color={COLORS.accent} />
                <View style={styles.rowText}>
                  <Text style={styles.rowExe} numberOfLines={1}>
                    {w.exe || "Aplikasi"}
                  </Text>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {w.title}
                  </Text>
                </View>
                <Text style={styles.rowTag}>{w.min ? "diminimize" : monLabel(w.mon)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Thin bar over the stream while a window is picked. Wrap in Block. */
export function WindowBar({ win, onRefit, onExit }) {
  function minimize() {
    send(msg.winAct(win.id, "min"));
    onExit();
  }
  function close() {
    Alert.alert("Tutup jendela?", `${win.exe || "Aplikasi"}: ${win.title}`, [
      { text: "Batal", style: "cancel" },
      {
        text: "Tutup",
        style: "destructive",
        onPress: () => {
          send(msg.winAct(win.id, "close"));
          onExit();
        },
      },
    ]);
  }
  return (
    <View style={styles.bar}>
      <MaterialCommunityIcons name="application-outline" size={16} color={COLORS.accent} />
      <Text style={styles.barTitle} numberOfLines={1}>
        {win.min ? `${win.title} (diminimize)` : win.title}
      </Text>
      <Pressable onPress={onRefit} hitSlop={6} style={styles.barBtn} accessibilityLabel="Fokus">
        <MaterialCommunityIcons name="target" size={17} color={COLORS.text} />
      </Pressable>
      <Pressable onPress={minimize} hitSlop={6} style={styles.barBtn} accessibilityLabel="Minimize">
        <MaterialCommunityIcons name="window-minimize" size={17} color={COLORS.text} />
      </Pressable>
      <Pressable onPress={close} hitSlop={6} style={styles.barBtn} accessibilityLabel="Tutup jendela">
        <MaterialCommunityIcons name="window-close" size={17} color="#ff6b6b" />
      </Pressable>
      <Pressable onPress={onExit} hitSlop={6} style={[styles.barBtn, styles.barExit]} accessibilityLabel="Keluar dari mode jendela">
        <Text style={styles.barExitText}>Semua</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  shade: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 20 },
  sheet: { backgroundColor: "#1c1c1f", borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, maxHeight: "75%", overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  headTitle: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
  list: { paddingVertical: 4 },
  empty: { color: COLORS.muted, fontSize: 13, padding: 16, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  rowPressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  rowText: { flex: 1 },
  rowExe: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  rowTitle: { color: COLORS.muted, fontSize: 12, marginTop: 1 },
  rowTag: { color: COLORS.muted, fontSize: 11 },
  bar: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(28,28,31,0.94)", borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, paddingVertical: 4, paddingLeft: 10, paddingRight: 4 },
  barTitle: { flex: 1, color: COLORS.text, fontSize: 12, fontWeight: "500" },
  barBtn: { width: 30, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  barExit: { width: undefined, paddingHorizontal: 8, backgroundColor: COLORS.fill },
  barExitText: { color: "#ffffff", fontSize: 11, fontWeight: "700" },
});
