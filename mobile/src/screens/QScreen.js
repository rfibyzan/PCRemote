/** Q: stream quality presets + fine-tune arrows (existing agent backend). */
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { COLORS } from "../components";
import { STORE_QUALITY, msg } from "../protocol";
import { send } from "../connection";

const PRESETS = ["lite", "low", "med", "high", "super"];

export default function QScreen() {
  const [preset, setPreset] = useState("low");
  const [qStep, setQStep] = useState(0);
  const [fpsStep, setFpsStep] = useState(0);

  useEffect(() => {
    SecureStore.getItemAsync(STORE_QUALITY).then((raw) => {
      try {
        const saved = JSON.parse(raw || "null");
        if (saved?.q) {
          setPreset(saved.q);
          setQStep(saved.qStep || 0);
          setFpsStep(saved.fpsStep || 0);
        }
      } catch {
        // fall back to defaults
      }
    }).catch(() => {});
  }, []);

  function apply(q, qs, fs) {
    setPreset(q);
    setQStep(qs);
    setFpsStep(fs);
    send(msg.quality({ q, qStep: qs, fpsStep: fs }));
    SecureStore.setItemAsync(STORE_QUALITY, JSON.stringify({ q, qStep: qs, fpsStep: fs })).catch(() => {});
  }

  function StepRow({ label, value, onMinus, onPlus }) {
    return (
      <View style={styles.stepRow}>
        <Text style={styles.stepLabel}>{label}</Text>
        <Pressable onPress={onMinus} style={styles.stepBtn}><Text style={styles.stepBtnText}>−</Text></Pressable>
        <Text style={styles.stepValue}>{value > 0 ? `+${value}` : `${value}`}</Text>
        <Pressable onPress={onPlus} style={styles.stepBtn}><Text style={styles.stepBtnText}>+</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Stream quality</Text>
      {PRESETS.map((p) => (
        <Pressable key={p} onPress={() => apply(p, qStep, fpsStep)} style={[styles.preset, preset === p && styles.presetActive]}>
          <Text style={[styles.presetText, preset === p && styles.presetTextActive]}>{p}</Text>
        </Pressable>
      ))}
      <StepRow label="JPEG detail" value={qStep}
        onMinus={() => apply(preset, Math.max(-5, qStep - 1), fpsStep)}
        onPlus={() => apply(preset, Math.min(8, qStep + 1), fpsStep)} />
      <StepRow label="Frame rate" value={fpsStep}
        onMinus={() => apply(preset, qStep, Math.max(-5, fpsStep - 1))}
        onPlus={() => apply(preset, qStep, Math.min(10, fpsStep + 1))} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg, padding: 16, gap: 8 },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "800", marginBottom: 4 },
  preset: { backgroundColor: COLORS.card, borderRadius: 12, padding: 14 },
  presetActive: { backgroundColor: "#0c4a6e" },
  presetText: { color: COLORS.muted, fontWeight: "700", textTransform: "capitalize" },
  presetTextActive: { color: COLORS.text },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: COLORS.card, borderRadius: 12, padding: 10 },
  stepLabel: { color: COLORS.text, flex: 1, fontWeight: "700" },
  stepBtn: { backgroundColor: COLORS.chip, borderRadius: 10, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  stepValue: { color: COLORS.accent, width: 40, textAlign: "center", fontWeight: "800" },
});
