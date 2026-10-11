/** TYPE: compact reference layout (no full QWERTY grid).
 * Layout (below the shared fixed-size viewer):
 *   free-text field (Enter never clears it)
 *   card: Hold | Ctrl Alt Shift Win | Send  /  Esc Tab Bksp Enter Del
 *   card: inverted-T arrows | Home PgUp / End PgDn
 * Protocol/functions preserved: key tap, down-only hold, combo chords, text.
 */
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "../components";
import { ConnDot } from "../controls";
import ViewerPanel from "../viewer";
import { msg } from "../protocol";
import { addListener, send } from "../connection";

const MODS = ["ctrl", "alt", "shift", "win"];
const SPECIAL = ["esc", "tab", "backspace", "enter", "delete"];
const SPECIAL_LABEL = { esc: "Esc", tab: "Tab", backspace: "Bksp", enter: "Enter", delete: "Del" };
const NAV = [
  { label: "←", key: "left" },
  { label: "→", key: "right" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
  { label: "Home", key: "home" },
  { label: "End", key: "end" },
  { label: "PgUp", key: "pageup" },
  { label: "PgDn", key: "pagedown" },
];

export default function TypeScreen() {
  const [held, setHeld] = useState([]);
  const [holdMode, setHoldMode] = useState(true);
  const [free, setFree] = useState("");
  // Modifier cleanup: held Ctrl/Alt/Shift/Win must never stay down on the PC
  // after unmount, socket close, or across a reconnect.
  const heldRef = useRef([]);
  heldRef.current = held;
  useEffect(() => {
    const off = addListener((event) => {
      if (event.t === "close" && heldRef.current.length) {
        send(msg.combo([...heldRef.current], false, true)); // best-effort
      }
      if (event.t === "hello" && heldRef.current.length) {
        send(msg.combo([...heldRef.current], false, true));
        setHeld([]);
      }
    });
    return () => {
      off();
      if (heldRef.current.length) send(msg.combo([...heldRef.current], false, true));
    };
  }, []);

  function tapKey(key) {
    if (held.length) {
      // chord: held modifiers + this key
      send(msg.combo([...held, key]));
      return;
    }
    send(msg.key(key));
  }

  function tapModifier(key) {
    if (holdMode) {
      if (held.includes(key)) {
        const next = held.filter((k) => k !== key);
        send(msg.combo([...held], false, true)); // release all
        if (next.length) send(msg.combo(next, true, false)); // re-hold remainder
        setHeld(next);
      } else {
        const next = [...held, key];
        send(msg.key(key, true, undefined)); // down only
        setHeld(next);
      }
      return;
    }
    send(msg.key(key)); // momentary tap when Hold mode is off
  }

  function toggleHoldMode() {
    if (holdMode && held.length) send(msg.combo([...held], false, true));
    if (holdMode) setHeld([]);
    setHoldMode(!holdMode);
  }

  // Send: dispatch the currently held modifiers as one press+release chord.
  // Assumption (not visible in the reference screenshot): Send transmits the
  // staged Hold combination. Uses only the existing combo protocol.
  function sendHeld() {
    if (!held.length) return;
    send(msg.combo([...held]));
    setHeld([]);
  }

  // Free-text field: Enter must NEVER clear the buffer. Soft-keyboard return
  // arrives as "\n" inside onChangeText (single-line renders it invisible, so
  // the field looked "empty") or as onSubmitEditing. Both send Enter to the
  // PC and keep the visible text intact (newlines stripped).
  function handleFreeChange(t) {
    const prev = free;
    const next = String(t ?? "");
    // Count newlines typed (usually 1 for Enter). Send one Enter per newline.
    const enters = (next.match(/\n/g) || []).length - (prev.match(/\n/g) || []).length;
    if (enters > 0) {
      for (let i = 0; i < Math.min(enters, 3); i += 1) send(msg.key("enter"));
      // Strip newlines so the field never looks mysteriously empty.
      setFree(next.replace(/\n/g, ""));
      // Any other added text besides the newline still needs sending.
      const addedText = next.replace(/\n/g, "").slice(prev.replace(/\n/g, "").length);
      if (addedText) send(msg.text(addedText));
      return;
    }
    if (next.length >= prev.length) {
      // Append-only fast path + paste/mid-edit fallback: send only the tail
      // that is genuinely new instead of assuming slice(prev.length).
      let start = 0;
      const minLen = Math.min(prev.length, next.length);
      while (start < minLen && prev[start] === next[start]) start += 1;
      const added = next.slice(start);
      setFree(next);
      if (added) send(msg.text(added));
    } else {
      // Deletion: count removed chars (select-all-delete removes many).
      const removed = prev.length - next.length;
      setFree(next);
      for (let i = 0; i < Math.min(Math.max(removed, 1), 50); i += 1) send(msg.key("backspace"));
    }
  }

  function handleFreeSubmit() {
    // Hardware/soft return with blurOnSubmit=false lands here: PC gets Enter,
    // phone buffer stays (no clearing).
    send(msg.key("enter"));
  }

  function Key({ label, active, onPress, onLongPress, wide, accent }) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        hitSlop={2}
        style={({ pressed }) => [
          styles.key,
          wide && styles.keyWide,
          accent && styles.keyAccent,
          active && styles.keyActive,
          pressed && styles.keyPressed,
        ]}
      >
        <Text style={[styles.keyText, active && styles.keyTextActive]}>{label}</Text>
      </Pressable>
    );
  }

  const nav = (k) => NAV.find((n) => n.key === k);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Type</Text>
        <ConnDot />
      </View>
      <ViewerPanel touchpad={false} actions={false} />
      <ScrollView style={styles.kb} contentContainerStyle={styles.kbContent} keyboardShouldPersistTaps="handled">
        <View style={styles.freeRow}>
          <TextInput
            style={styles.free}
            value={free}
            onChangeText={handleFreeChange}
            onSubmitEditing={handleFreeSubmit}
            placeholder="Ketik seperti keyboard PC"
            placeholderTextColor={COLORS.muted}
            autoCapitalize="none"
            autoCorrect={false}
            multiline={false}
            blurOnSubmit={false}
            returnKeyType="send"
            submitBehavior="submit"
          />
          {!!free && (
            <Pressable onPress={() => setFree("")} style={styles.clearBtn} accessibilityLabel="Clear typed text">
              <Text style={styles.clearText}>✕</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Key label={holdMode ? "Hold ●" : "Hold"} active={holdMode} onPress={toggleHoldMode} />
            {MODS.map((k) => (
              <Key key={k} label={k[0].toUpperCase() + k.slice(1)} active={held.includes(k)} onPress={() => tapModifier(k)} />
            ))}
            <Key label="Send" accent onPress={sendHeld} />
          </View>
          <View style={styles.row}>
            {SPECIAL.map((k) => (
              <Key key={k} label={SPECIAL_LABEL[k]} onPress={() => tapKey(k)} />
            ))}
          </View>
        </View>

        <View style={[styles.card, styles.navCard]}>
          <View style={styles.arrows}>
            <View style={styles.row}>
              <View style={styles.keySpacer} />
              <Key label="↑" onPress={() => tapKey(nav("up").key)} />
              <View style={styles.keySpacer} />
            </View>
            <View style={styles.row}>
              <Key label="←" onPress={() => tapKey(nav("left").key)} />
              <Key label="↓" onPress={() => tapKey(nav("down").key)} />
              <Key label="→" onPress={() => tapKey(nav("right").key)} />
            </View>
          </View>
          <View style={styles.navKeys}>
            <View style={styles.row}>
              <Key label="Home" onPress={() => tapKey("home")} />
              <Key label="PgUp" onPress={() => tapKey("pageup")} />
            </View>
            <View style={styles.row}>
              <Key label="End" onPress={() => tapKey("end")} />
              <Key label="PgDn" onPress={() => tapKey("pagedown")} />
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  kb: { flex: 1 },
  kbContent: { paddingHorizontal: 8, paddingBottom: 12, gap: 8 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, height: 32 },
  title: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  card: { backgroundColor: COLORS.card, borderRadius: 12, padding: 6, gap: 6 },
  navCard: { flexDirection: "row", gap: 10 },
  arrows: { flex: 3, gap: 6 },
  navKeys: { flex: 2, gap: 6 },
  row: { flexDirection: "row", gap: 6 },
  key: { flex: 1, height: 38, backgroundColor: COLORS.chip, borderRadius: 8, alignItems: "center", justifyContent: "center", minWidth: 0 },
  keySpacer: { flex: 1 },
  keyWide: { flex: 2 },
  keyAccent: { backgroundColor: "#075985" },
  keyActive: { backgroundColor: "#0c4a6e", borderWidth: 1, borderColor: COLORS.accent },
  keyPressed: { opacity: 0.6 },
  keyText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  keyTextActive: { color: COLORS.accent },
  free: { flex: 1, height: 44, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 12, paddingHorizontal: 12 },
  freeRow: { flexDirection: "row", gap: 6, alignItems: "center" },
  clearBtn: { backgroundColor: COLORS.chip, borderRadius: 10, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  clearText: { color: COLORS.muted, fontWeight: "800", fontSize: 14 },
});
