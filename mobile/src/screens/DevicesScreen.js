/** Perangkat: the PC this phone is on (disconnect / log out), recent PCs
 * (one tap to switch), this phone's identity as the PC sees it, and the
 * full connection log. Opened from the connection dot in the header. */
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { PressScale, Pulse } from "../motion";
import Text from "../AppText";
import { COLORS } from "../components";
import { addListener, clearPairing, connectToCode, disconnectByUser, forgetRecent, getStatus } from "../connection";
import { LogPanel, RecentList, panelStyles, useRecent } from "./ConnPanels";

export default function DevicesScreen({ onBack, onConnected, onLoggedOut }) {
  const [st, setSt] = useState(getStatus());
  const [busy, setBusy] = useState(false);
  const recent = useRecent();

  useEffect(
    () =>
      addListener((e) => {
        if (e.t === "status" || e.t === "progress" || e.t === "hello" || e.t === "close" || e.t === "code") setSt(getStatus());
        if (e.t === "hello" && busy) onConnected();
      }),
    [busy, onConnected],
  );

  async function switchTo(r) {
    setBusy(true);
    try {
      await connectToCode(r.code);
    } catch {
      // shown in the log
    } finally {
      setBusy(false);
    }
  }

  const dev = st.device;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.root}>
      <View style={styles.head}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
          <Text style={styles.back}>‹ Kembali</Text>
        </Pressable>
        <Text style={styles.title}>Perangkat</Text>
      </View>

      <View style={styles.card}>
        <Text style={panelStyles.sectionTitle}>PC sekarang</Text>
        <View style={styles.pcRow}>
          <Pulse on={!st.connected && st.status === "reconnecting"} min={0.35}>
            <Text style={[styles.dot, { color: st.connected ? COLORS.ok : st.status === "reconnecting" ? "#facc15" : COLORS.muted }]}>●</Text>
          </Pulse>
          <View style={{ flex: 1 }}>
            <Text style={styles.pcName}>{st.pcName || (st.code ? "PC" : "Belum ada PC")}</Text>
            <Text style={styles.meta}>
              {st.connected ? `Terhubung via ${st.link}` : st.status}
              {st.code ? ` · kode ${st.code.slice(0, 2)}••••••` : ""}
            </Text>
          </View>
        </View>
        {!!st.code && (
          <View style={styles.row}>
            {st.connected && (
              <PressScale style={styles.btn} onPress={() => disconnectByUser()}>
                <Text style={styles.btnText}>Putuskan</Text>
              </PressScale>
            )}
            <PressScale
              style={[styles.btn, styles.btnDanger]}
              onPress={() => {
                clearPairing();
                onLoggedOut();
              }}
            >
              <Text style={styles.btnDangerText}>Log out dari PC ini</Text>
            </PressScale>
          </View>
        )}
        <Text style={styles.small}>Log out menghapus kode PC dari HP ini. PC tetap ada di Recent sampai kamu hapus (✕).</Text>
      </View>

      <RecentList
        recent={recent.filter((r) => r.code !== st.code)}
        currentCode={st.code}
        busy={busy}
        onConnect={switchTo}
        onForget={(r) => forgetRecent(r.code)}
      />

      {!!dev && (
        <View style={styles.card}>
          <Text style={panelStyles.sectionTitle}>HP ini (terlihat di dashboard PC)</Text>
          <Text style={styles.pcName}>{dev.name}</Text>
          <Text style={styles.meta}>
            {dev.os} · app {dev.app || "?"} · ID {String(dev.id).slice(0, 8)}
          </Text>
        </View>
      )}

      <LogPanel lines={14} maxHeight={320} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  root: { padding: 16, paddingTop: 44, gap: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 14 },
  backBtn: { backgroundColor: COLORS.chip, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16 },
  back: { color: COLORS.accent, fontWeight: "800", fontSize: 16 },
  title: { color: COLORS.text, fontSize: 22, fontWeight: "800" },
  card: { backgroundColor: COLORS.card, borderRadius: 14, padding: 14, gap: 8 },
  pcRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { fontSize: 14 },
  pcName: { color: COLORS.text, fontWeight: "800", fontSize: 16 },
  meta: { color: COLORS.muted, fontSize: 12 },
  row: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  btn: { flexGrow: 1, alignItems: "center", backgroundColor: COLORS.chip, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18 },
  btnText: { color: COLORS.text, fontWeight: "800", fontSize: 15 },
  btnDanger: { borderWidth: 1, borderColor: "#7f1d1d", backgroundColor: "transparent" },
  btnDangerText: { color: COLORS.danger, fontWeight: "800", fontSize: 15 },
  small: { color: "#6e6e73", fontSize: 11 },
});
