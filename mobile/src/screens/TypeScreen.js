/** TYPE (layout C): shared viewer on top, fixed control area below:
 *   free-text field (Enter never clears it)
 *   row 1, page A: Ctrl Alt Shift Win Esc Tab Del
 *   row 1, page B: Hold Send Home End PgUp PgDn Ins
 *   row 2 (always): Bksp Enter ← ↑ ↓ → and ⋯ (flips page A/B)
 * Protocol/functions preserved: key tap, down-only hold, combo chords, text.
 */
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "../components";
import ViewerPanel from "../viewer";
import { rowHeight } from "../tablayout";
import { msg } from "../protocol";
import { addListener, send } from "../connection";

const MODS = ["ctrl", "alt", "shift", "win"];
const FIELD_H = 36;
// Last key page survives tab switches.
let lastPage = "A";

export default function TypeScreen() {
  const [held, setHeld] = useState([]);
  const [holdMode, setHoldMode] = useState(true);
  const [free, setFree] = useState("");
  const [page, setPageState] = useState(lastPage);
  function setPage(v) {
    lastPage = v;
    setPageState(v);
  }
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

  // Two pages share the same two key rows; "⋯" flips between them so the
  // control area never grows (layout C keeps the viewer big).
  const ROW_COMMON = [
    { label: "Bksp", onPress: () => tapKey("backspace") },
    { label: "Enter", onPress: () => tapKey("enter") },
    { label: "←", onPress: () => tapKey("left") },
    { label: "↑", onPress: () => tapKey("up") },
    { label: "↓", onPress: () => tapKey("down") },
    { label: "→", onPress: () => tapKey("right") },
  ];
  const ROW_A = [
    ...MODS.map((k) => ({ label: k[0].toUpperCase() + k.slice(1), active: held.includes(k), onPress: () => tapModifier(k) })),
    { label: "Esc", onPress: () => tapKey("esc") },
    { label: "Tab", onPress: () => tapKey("tab") },
    { label: "Del", onPress: () => tapKey("delete") },
  ];
  const ROW_B = [
    { label: holdMode ? "Hold●" : "Hold", active: holdMode, onPress: toggleHoldMode },
    { label: "Send", accent: true, onPress: sendHeld },
    { label: "Home", onPress: () => tapKey("home") },
    { label: "End", onPress: () => tapKey("end") },
    { label: "PgUp", onPress: () => tapKey("pageup") },
    { label: "PgDn", onPress: () => tapKey("pagedown") },
    { label: "Ins", onPress: () => tapKey("insert") },
  ];
  const rows = [page === "B" ? ROW_B : ROW_A, ROW_COMMON];
  const keyH = rowHeight(2, [FIELD_H]);
  const heldHint = held.length ? held.map((k) => k[0].toUpperCase() + k.slice(1)).join("+") + " + …" : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ViewerPanel title="Type" touchpad={false} actions={false}>
        <View style={styles.freeRow}>
          <TextInput
            style={styles.free}
            value={free}
            onChangeText={handleFreeChange}
            onSubmitEditing={handleFreeSubmit}
            placeholder={heldHint || "Ketik seperti keyboard PC"}
            placeholderTextColor={heldHint ? COLORS.accent : COLORS.muted}
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
        {rows.map((r, ri) => (
          <View key={ri} style={[styles.row, { height: keyH }]}>
            {r.map((k, ki) => (
              <Key key={ki} {...k} />
            ))}
            {ri === 1 && (
              <Key label={page === "B" ? "abc" : "⋯"} active={page === "B"} onPress={() => setPage(page === "B" ? "A" : "B")} />
            )}
          </View>
        ))}
      </ViewerPanel>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  row: { flexDirection: "row", gap: 5 },
  key: { flex: 1, backgroundColor: COLORS.chip, borderRadius: 8, alignItems: "center", justifyContent: "center", minWidth: 0 },
  keyWide: { flex: 2 },
  keyAccent: { backgroundColor: "#075985" },
  keyActive: { backgroundColor: "#0c4a6e", borderWidth: 1, borderColor: COLORS.accent },
  keyPressed: { opacity: 0.6 },
  keyText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  keyTextActive: { color: COLORS.accent },
  free: { flex: 1, height: FIELD_H, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 0 },
  freeRow: { flexDirection: "row", gap: 6, alignItems: "center", height: FIELD_H },
  clearBtn: { backgroundColor: COLORS.chip, borderRadius: 10, width: FIELD_H, height: FIELD_H, alignItems: "center", justifyContent: "center" },
  clearText: { color: COLORS.muted, fontWeight: "800", fontSize: 14 },
});
