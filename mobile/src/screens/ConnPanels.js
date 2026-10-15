/** Shared pieces of the connect + devices screens: the live connection log
 * (with Share/copy) and the recent-PC list. */
import React, { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from "react-native";
import Text from "../AppText";
import { COLORS } from "../components";
import { addListener, connLog, connLogText, getRecent } from "../connection";
import { clockOf } from "../connlog";
import { agoText } from "../recent";

const LEVEL_COLOR = { error: COLORS.danger, warn: "#fbbf24", ok: COLORS.ok, info: "#d1d1d6" };

export function useConnLog() {
  const [items, setItems] = useState(connLog.list());
  useEffect(() => connLog.subscribe((list) => setItems(list.slice())), []);
  return items;
}

export function useRecent() {
  const [recent, setRecent] = useState(getRecent());
  useEffect(() => {
    setRecent(getRecent());
    return addListener((e) => {
      if (e.t === "recent" || e.t === "hello" || e.t === "code") setRecent(getRecent());
    });
  }, []);
  return recent;
}

export function shareLog() {
  Share.share({ message: connLogText(), title: "PCRemote log" }).catch(() => {});
}

/** Newest line on top. `lines` = how many to show before "Semua". */
export function LogPanel({ lines = 6, maxHeight = 180, title = "Log koneksi" }) {
  const items = useConnLog();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, lines);
  return (
    <View style={styles.logBox}>
      <View style={styles.logHead}>
        <Text style={styles.logTitle}>{title}</Text>
        {items.length > lines && (
          <Pressable onPress={() => setAll((v) => !v)} hitSlop={6}>
            <Text style={styles.logBtn}>{all ? "Ringkas" : `Semua (${items.length})`}</Text>
          </Pressable>
        )}
        <Pressable onPress={shareLog} hitSlop={6}>
          <Text style={styles.logBtn}>Salin / Bagikan</Text>
        </Pressable>
      </View>
      <ScrollView style={{ maxHeight: all ? maxHeight * 2 : maxHeight }} nestedScrollEnabled>
        {shown.length ? (
          shown.map((it, i) => (
            <Text key={`${it.ts}-${i}`} style={[styles.logLine, { color: LEVEL_COLOR[it.level] || LEVEL_COLOR.info }]}>
              <Text style={styles.logTime}>{clockOf(it.ts).slice(0, 8)} </Text>
              {it.text}
            </Text>
          ))
        ) : (
          <Text style={styles.logEmpty}>Belum ada aktivitas.</Text>
        )}
      </ScrollView>
    </View>
  );
}

export function RecentList({ recent, currentCode, onConnect, onForget, busy }) {
  if (!recent.length) return null;
  return (
    <View style={styles.recentBox}>
      <Text style={styles.sectionTitle}>Recent PC</Text>
      {recent.map((r) => {
        const current = r.code === currentCode;
        return (
          <View key={r.code} style={styles.recentRow}>
            <Pressable style={styles.recentMain} disabled={busy} onPress={() => onConnect(r)}>
              <Text style={styles.recentName} numberOfLines={1}>
                {r.name || "PC"}
                {current ? "  ·  aktif" : ""}
              </Text>
              <Text style={styles.recentMeta} numberOfLines={1}>
                {agoText(r.lastAt)}
                {r.link ? ` · ${r.link}` : ""} · kode {r.code.slice(0, 2)}••••••
              </Text>
            </Pressable>
            <Pressable
              hitSlop={8}
              style={styles.recentX}
              onPress={() =>
                Alert.alert("Hapus PC?", `${r.name || "PC"} dihapus dari HP ini. Untuk konek lagi perlu scan QR.`, [
                  { text: "Batal", style: "cancel" },
                  { text: "Hapus", style: "destructive", onPress: () => onForget(r) },
                ])
              }
            >
              <Text style={styles.recentXText}>✕</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

export const panelStyles = StyleSheet.create({
  sectionTitle: { color: COLORS.muted, fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
});

const styles = StyleSheet.create({
  logBox: { backgroundColor: "#161618", borderRadius: 12, padding: 10, gap: 4 },
  logHead: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 2 },
  logTitle: { color: COLORS.muted, fontSize: 12, fontWeight: "800", flex: 1, letterSpacing: 1, textTransform: "uppercase" },
  logBtn: { color: COLORS.accent, fontSize: 13, fontWeight: "800", paddingVertical: 6, paddingHorizontal: 4 },
  logLine: { fontSize: 11, fontFamily: "monospace", paddingVertical: 1 },
  logTime: { color: "#6e6e73" },
  logEmpty: { color: "#6e6e73", fontSize: 12 },
  sectionTitle: panelStylesTitle(),
  recentBox: { gap: 6 },
  recentRow: { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.card, borderRadius: 12 },
  recentMain: { flex: 1, paddingVertical: 14, paddingHorizontal: 14 },
  recentName: { color: COLORS.text, fontWeight: "800", fontSize: 14 },
  recentMeta: { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  recentX: { paddingHorizontal: 18, paddingVertical: 16, borderLeftWidth: 1, borderLeftColor: "#2c2c30" },
  recentXText: { color: COLORS.danger, fontWeight: "800", fontSize: 18 },
});

function panelStylesTitle() {
  return { color: COLORS.muted, fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" };
}
