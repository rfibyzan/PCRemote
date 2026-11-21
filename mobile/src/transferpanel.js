/** Small card over the viewer listing file transfers (filexfer.js):
 * progress while sending/receiving, then "Buka" / "Simpan" for a file from
 * the PC, or where it landed on the PC. Each row can be closed (✕). */
import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Text from "./AppText";
import { COLORS } from "./components";
import { dismissTransfer, openReceived, saveReceived, useTransfers } from "./filexfer";

function fmtSize(b) {
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

function Row({ tr }) {
  const [busy, setBusy] = useState(false);
  const waiting = tr.status === "waiting";
  const active = waiting || tr.status === "sending" || tr.status === "receiving";
  const pct = tr.size ? Math.min(1, tr.got / tr.size) : tr.status === "done" ? 1 : 0;
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn(tr);
    } catch (err) {
      Alert.alert("PC Remote", String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };
  let line;
  if (tr.status === "error") line = tr.error || "gagal";
  else if (waiting) line = "Menunggu koneksi ke PC…";
  else if (active) line = `${tr.dir === "out" ? "Mengirim ke PC" : "Menerima dari PC"} · ${Math.round(pct * 100)}% dari ${fmtSize(tr.size)}`;
  else if (tr.dir === "out") line = "Tersimpan di PC: Downloads\\PC Remote";
  else line = tr.saved ? "Tersimpan di HP" : `Diterima · ${fmtSize(tr.size)}`;
  return (
    <View style={styles.row}>
      <MaterialCommunityIcons
        name={tr.status === "error" ? "alert-circle-outline" : tr.dir === "out" ? "arrow-up-circle-outline" : "arrow-down-circle-outline"}
        size={20}
        color={tr.status === "error" ? COLORS.danger : tr.status === "done" ? COLORS.ok : COLORS.accent}
      />
      <View style={styles.mid}>
        <Text style={styles.name} numberOfLines={1}>{tr.name}</Text>
        <Text style={[styles.line, tr.status === "error" && styles.lineErr]} numberOfLines={1}>{line}</Text>
        {active && !waiting && (
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(pct * 100)}%` }]} />
          </View>
        )}
      </View>
      {tr.dir === "in" && tr.status === "done" && (
        <>
          <Pressable disabled={busy} onPress={() => run(openReceived)} style={styles.act} hitSlop={4}>
            <Text style={styles.actText}>Buka</Text>
          </Pressable>
          {!tr.saved && (
            <Pressable disabled={busy} onPress={() => run(saveReceived)} style={[styles.act, styles.actMain]} hitSlop={4}>
              <Text style={styles.actText}>Simpan</Text>
            </Pressable>
          )}
        </>
      )}
      {!active && (
        <Pressable onPress={() => dismissTransfer(tr.id)} hitSlop={8} accessibilityLabel="Tutup">
          <MaterialCommunityIcons name="close" size={16} color={COLORS.muted} />
        </Pressable>
      )}
    </View>
  );
}

export default function TransferPanel({ style }) {
  const list = useTransfers();
  if (!list.length) return null;
  return (
    <View style={[styles.box, style]}>
      {list.slice(0, 3).map((tr) => (
        <Row key={tr.id} tr={tr} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: "rgba(22,22,24,0.96)", borderRadius: 14, borderWidth: 1, borderColor: "#3a3a3e", paddingVertical: 4, paddingHorizontal: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  mid: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  line: { color: COLORS.muted, fontSize: 11 },
  lineErr: { color: COLORS.danger },
  bar: { height: 4, borderRadius: 2, backgroundColor: "#2c2c30", overflow: "hidden", marginTop: 2 },
  barFill: { height: 4, borderRadius: 2, backgroundColor: COLORS.accent },
  act: { height: 30, paddingHorizontal: 10, borderRadius: 8, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  actMain: { backgroundColor: COLORS.fill },
  actText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
});
