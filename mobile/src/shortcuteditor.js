/** Editor sheet for one custom shortcut (WIN > Pintasan): name, modifier
 * chips, one main key from a paged picker, preview, Tes kirim, Simpan. */
import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Text from "./AppText";
import Animated, { FadeIn } from "react-native-reanimated";
import { COLORS } from "./components";
import { MotionModal, MotionPanel, PressScale, useLatched } from "./motion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { msg } from "./protocol";
import { send } from "./connection";
import { SC_KEY_PAGES, SC_MODS, SC_MOD_LABEL, comboKeys, comboLabel, keyLabel } from "./shortcutmath";

// Main-key picker: a real grid - every key on a page has the same width, so
// columns line up and the right edge is straight. Long names (Backspace,
// PgDn) get fewer, wider columns. The box keeps one height for every page
// (A-Z fits without scrolling), so the sheet never jumps when switching.
const KEY_GAP = 6;
const KEY_H = 40;
const KEY_ROWS = 4;
const KEYS_H = KEY_ROWS * KEY_H + (KEY_ROWS - 1) * KEY_GAP + 4;
function colsFor(keys) {
  const longest = Math.max(...keys.map((k) => keyLabel(k).length));
  return longest > 3 ? 4 : 7;
}

export default function ShortcutEditor({ visible, initial, onSave, onDelete, onClose }) {
  const shown = useLatched(initial); // title stays put while the sheet fades out
  const del = useLatched(onDelete);
  const [name, setName] = useState("");
  const [mods, setMods] = useState([]);
  const [key, setKey] = useState("");
  const [page, setPage] = useState(0);
  const [gridW, setGridW] = useState(0);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    setName(initial?.name || "");
    setMods(initial?.mods || []);
    setKey(initial?.key || "");
    const p = SC_KEY_PAGES.findIndex(([, keys]) => keys.includes(initial?.key));
    setPage(p >= 0 ? p : 0);
  }, [visible, initial]);

  const draft = { id: initial?.id, name: name.trim(), mods, key };
  const ready = Boolean(key);
  const toggleMod = (m) => setMods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  const pageKeys = SC_KEY_PAGES[page][1];
  const cols = colsFor(pageKeys);
  const keyW = gridW ? Math.floor((gridW - KEY_GAP * (cols - 1)) / cols) : 0;
  const canDelete = Boolean(visible ? onDelete : del);

  return (
    <MotionModal visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.dim} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap} pointerEvents="box-none">
        <MotionPanel kind="sheet" style={[styles.sheet, { paddingBottom: 16 + insets.bottom }]}>
          <View style={styles.grab} />
          <Text style={styles.title}>{shown?.id ? "Edit pintasan" : "Pintasan baru"}</Text>

          <Text style={styles.label}>Nama</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder={ready ? comboLabel(draft) : "mis. Listary"}
            placeholderTextColor={COLORS.muted}
            maxLength={24}
          />

          <Text style={styles.label}>Tombol pengubah</Text>
          <View style={styles.row}>
            {SC_MODS.map((m) => (
              <PressScale key={m} onPress={() => toggleMod(m)} style={[styles.mod, mods.includes(m) && styles.on]}>
                <Text style={[styles.modText, mods.includes(m) && styles.onText]}>{SC_MOD_LABEL[m]}</Text>
              </PressScale>
            ))}
          </View>

          <Text style={styles.label}>Tombol utama</Text>
          <View style={styles.pages}>
            {SC_KEY_PAGES.map(([title], i) => (
              <Pressable key={title} onPress={() => setPage(i)} style={[styles.pageTab, page === i && styles.on]}>
                <Text style={[styles.pageText, page === i && styles.onText]}>{title}</Text>
              </Pressable>
            ))}
          </View>
          <ScrollView
            style={styles.keysBox}
            contentContainerStyle={styles.keys}
            nestedScrollEnabled
            onLayout={(e) => setGridW(Math.floor(e.nativeEvent.layout.width))}
          >
            {!!keyW &&
              pageKeys.map((k) => (
                <PressScale key={k} onPress={() => setKey(k)} style={[styles.key, { width: keyW }, key === k && styles.on]}>
                  <Text style={[styles.keyText, key === k && styles.onText]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                    {keyLabel(k)}
                  </Text>
                </PressScale>
              ))}
          </ScrollView>

          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Pratinjau</Text>
            <Animated.View key={ready ? comboLabel(draft) : "-"} entering={FadeIn.duration(160)} style={styles.previewBox}>
              <Text style={[styles.preview, !ready && styles.previewEmpty]} numberOfLines={1}>
                {ready ? comboLabel(draft) : "Pilih tombol utama"}
              </Text>
            </Animated.View>
          </View>

          <View style={[styles.row, styles.actions]}>
            {canDelete ? (
              <PressScale onPress={visible ? onDelete : del} style={[styles.btn, styles.danger]}>
                <Text style={styles.btnText}>Hapus</Text>
              </PressScale>
            ) : null}
            <PressScale disabled={!ready} onPress={() => send(msg.combo(comboKeys(draft)))} style={[styles.btn, !ready && styles.off]}>
              <Text style={styles.btnText}>Tes kirim</Text>
            </PressScale>
            <PressScale disabled={!ready} onPress={() => onSave(draft)} style={[styles.btn, styles.primary, !ready && styles.off]}>
              <Text style={styles.btnText}>Simpan</Text>
            </PressScale>
          </View>
          <Text style={styles.note}>Tersimpan di HP dan di PC (agent baru), jadi kembali setelah instal ulang.</Text>
        </MotionPanel>
      </KeyboardAvoidingView>
    </MotionModal>
  );
}

const styles = StyleSheet.create({
  dim: { ...StyleSheet.absoluteFillObject },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: { backgroundColor: COLORS.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  grab: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.line, marginBottom: 6 },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "800", marginBottom: 2 },
  label: { color: COLORS.muted, fontSize: 11, fontWeight: "800", letterSpacing: 0.4, marginTop: 8, marginBottom: 2 },
  input: { height: 42, backgroundColor: COLORS.chip, color: COLORS.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 0 },
  row: { flexDirection: "row", gap: 6 },
  mod: { flex: 1, height: 40, borderRadius: 10, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  modText: { color: COLORS.muted, fontWeight: "800" },
  on: { backgroundColor: COLORS.fill },
  onText: { color: COLORS.text },
  pages: { flexDirection: "row", gap: KEY_GAP },
  pageTab: { flex: 1, minWidth: 0, height: 32, borderRadius: 8, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  pageText: { color: COLORS.muted, fontWeight: "800", fontSize: 11 },
  keysBox: { height: KEYS_H, flexGrow: 0 },
  keys: { flexDirection: "row", flexWrap: "wrap", gap: KEY_GAP, paddingTop: 4 },
  key: { height: KEY_H, borderRadius: 8, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center", paddingHorizontal: 2 },
  keyText: { color: COLORS.text, fontWeight: "700", fontSize: 13 },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  previewLabel: { color: COLORS.muted, fontSize: 11, fontWeight: "800", letterSpacing: 0.4 },
  previewBox: { flex: 1, height: 40, borderRadius: 10, backgroundColor: COLORS.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: COLORS.line, justifyContent: "center", paddingHorizontal: 12 },
  preview: { color: COLORS.accent, fontWeight: "800", fontSize: 15 },
  previewEmpty: { color: COLORS.muted, fontWeight: "600", fontSize: 13 },
  actions: { marginTop: 10 },
  btn: { flex: 1, height: 44, borderRadius: 12, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: COLORS.fill },
  danger: { backgroundColor: "#7f1d1d" },
  off: { opacity: 0.4 },
  btnText: { color: COLORS.text, fontWeight: "800" },
  note: { color: COLORS.muted, fontSize: 11, textAlign: "center", marginTop: 4 },
});
