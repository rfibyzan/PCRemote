/** Editor sheet for one custom shortcut (WIN > Pintasan): name, modifier
 * chips, one main key from a paged picker, preview, Tes kirim, Simpan. */
import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Text from "./AppText";
import { COLORS } from "./components";
import { msg } from "./protocol";
import { send } from "./connection";
import { SC_KEY_PAGES, SC_MODS, SC_MOD_LABEL, comboKeys, comboLabel, keyLabel } from "./shortcutmath";

export default function ShortcutEditor({ visible, initial, onSave, onDelete, onClose }) {
  const [name, setName] = useState("");
  const [mods, setMods] = useState([]);
  const [key, setKey] = useState("");
  const [page, setPage] = useState(0);

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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.dim} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap}>
        <View style={styles.sheet}>
          <View style={styles.grab} />
          <Text style={styles.title}>{initial?.id ? "Edit pintasan" : "Pintasan baru"}</Text>

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
              <Pressable key={m} onPress={() => toggleMod(m)} style={[styles.mod, mods.includes(m) && styles.on]}>
                <Text style={[styles.modText, mods.includes(m) && styles.onText]}>{SC_MOD_LABEL[m]}</Text>
              </Pressable>
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
          <ScrollView style={styles.keysBox} contentContainerStyle={styles.keys} nestedScrollEnabled>
            {SC_KEY_PAGES[page][1].map((k) => (
              <Pressable key={k} onPress={() => setKey(k)} style={[styles.key, key === k && styles.on]}>
                <Text style={[styles.keyText, key === k && styles.onText]}>{keyLabel(k)}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.label}>Pratinjau</Text>
          <Text style={styles.preview}>{ready ? comboLabel(draft) : "Pilih tombol utama"}</Text>

          <View style={styles.row}>
            {onDelete ? (
              <Pressable onPress={onDelete} style={[styles.btn, styles.danger]}>
                <Text style={styles.btnText}>Hapus</Text>
              </Pressable>
            ) : null}
            <Pressable disabled={!ready} onPress={() => send(msg.combo(comboKeys(draft)))} style={[styles.btn, !ready && styles.off]}>
              <Text style={styles.btnText}>Tes kirim</Text>
            </Pressable>
            <Pressable disabled={!ready} onPress={() => onSave(draft)} style={[styles.btn, styles.primary, !ready && styles.off]}>
              <Text style={styles.btnText}>Simpan</Text>
            </Pressable>
          </View>
          <Text style={styles.note}>Tersimpan di HP dan di PC (agent baru), jadi kembali setelah instal ulang.</Text>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: { backgroundColor: COLORS.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 16, paddingBottom: 24, gap: 6 },
  grab: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.line, marginBottom: 6 },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "800", marginBottom: 4 },
  label: { color: COLORS.muted, fontSize: 11, fontWeight: "800", marginTop: 6 },
  input: { height: 42, backgroundColor: COLORS.chip, color: COLORS.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 0 },
  row: { flexDirection: "row", gap: 6 },
  mod: { flex: 1, height: 40, borderRadius: 10, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  modText: { color: COLORS.muted, fontWeight: "800" },
  on: { backgroundColor: COLORS.fill },
  onText: { color: COLORS.text },
  pages: { flexDirection: "row", gap: 4 },
  pageTab: { flex: 1, height: 28, borderRadius: 8, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  pageText: { color: COLORS.muted, fontWeight: "800", fontSize: 11 },
  keysBox: { maxHeight: 132 },
  keys: { flexDirection: "row", flexWrap: "wrap", gap: 5, paddingTop: 4 },
  key: { minWidth: 40, height: 38, paddingHorizontal: 8, borderRadius: 8, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  keyText: { color: COLORS.text, fontWeight: "700" },
  preview: { color: COLORS.accent, fontWeight: "800", fontSize: 16, marginBottom: 6 },
  btn: { flex: 1, height: 44, borderRadius: 12, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: COLORS.fill },
  danger: { backgroundColor: "#7f1d1d", flex: 0.7 },
  off: { opacity: 0.4 },
  btnText: { color: COLORS.text, fontWeight: "800" },
  note: { color: COLORS.muted, fontSize: 11, textAlign: "center", marginTop: 4 },
});
