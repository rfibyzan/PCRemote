/** TYPE (layout C): shared viewer on top, fixed control area below:
 *   row 0: "Ketik langsung" (default) or "Kolom teks" mode, toggle chip at the right
 *     - Ketik langsung: opens the phone keyboard on a hidden input; every key
 *       goes to the PC at once as REAL key presses (games/hotkeys see them).
 *       While typing, the viewer chrome hides and a small pill (Ctrl/Esc/close)
 *       floats over the stream.
 *     - Kolom teks: type into a field, "Kirim" sends it as Unicode (long text).
 *   row 1, page A: Ctrl Alt Shift Win Esc Tab Del
 *   row 1, page B: Hold Paste Home End PgUp PgDn Ins
 *   row 2 (always): Bksp Enter ← ↑ ↓ → and ⋯ (flips page A/B)
 * Protocol/functions preserved: key tap, down-only hold, combo chords, text.
 */
import React, { useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, StyleSheet, TextInput, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Text from "../AppText";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "../components";
import ViewerPanel, { Block } from "../viewer";
import { setSel } from "../controls";
import { SENTINELS, chordKey, diffInput, pushRecent } from "../typediff";
import { rowHeight } from "../tablayout";
import { registerSetting, settingChanged } from "../settingsync";
import { msg } from "../protocol";
import { addListener, send } from "../connection";

const MODS = ["ctrl", "alt", "shift", "win"];
const FIELD_H = 36;
// Last key page survives tab switches.
let lastPage = "A";
const STORE_TYPE = "pcremote.type"; // { mode: "live" | "field", hold: bool }
const pref = { mode: "live", hold: true, loaded: false };
const prefListeners = new Set();
function storePref() {
  SecureStore.setItemAsync(STORE_TYPE, JSON.stringify({ mode: pref.mode, hold: pref.hold })).catch(() => {});
}
function savePref() {
  storePref();
  settingChanged("type", { mode: pref.mode, hold: pref.hold });
}
registerSetting("type", {
  read: async () => {
    const raw = await SecureStore.getItemAsync(STORE_TYPE);
    return raw ? JSON.parse(raw) : null;
  },
  apply: (v) => {
    if (!v) return;
    if (v.mode === "live" || v.mode === "field") pref.mode = v.mode;
    if (typeof v.hold === "boolean") pref.hold = v.hold;
    pref.loaded = true;
    storePref();
    for (const l of [...prefListeners]) l();
  },
});

export default function TypeScreen() {
  const [held, setHeld] = useState([]);
  const [holdMode, setHoldModeState] = useState(pref.hold);
  const [mode, setModeState] = useState(pref.mode);
  const [free, setFree] = useState("");
  const [typing, setTyping] = useState(false);
  const [recent, setRecent] = useState("");
  const liveRef = useRef(null);
  const liveVal = useRef(SENTINELS[0]);
  const [liveText, setLiveText] = useState(SENTINELS[0]);
  function setHoldMode(v) {
    pref.hold = v;
    savePref();
    setHoldModeState(v);
  }
  function setMode(v) {
    pref.mode = v;
    savePref();
    setModeState(v);
  }
  // Saved choices (Hold on/off, mode) survive restarts.
  useEffect(() => {
    if (pref.loaded) return;
    SecureStore.getItemAsync(STORE_TYPE)
      .then((raw) => {
        pref.loaded = true;
        const v = raw ? JSON.parse(raw) : null;
        if (v && (v.mode === "live" || v.mode === "field")) {
          pref.mode = v.mode;
          setModeState(v.mode);
        }
        if (v && typeof v.hold === "boolean") {
          pref.hold = v.hold;
          setHoldModeState(v.hold);
        }
      })
      .catch(() => {
        pref.loaded = true;
      });
  }, []);
  // Settings restored from the PC (settingsync) refresh the toggles.
  useEffect(() => {
    const onPref = () => {
      setModeState(pref.mode);
      setHoldModeState(pref.hold);
    };
    prefListeners.add(onPref);
    return () => prefListeners.delete(onPref);
  }, []);
  // Live typing owns the viewer chrome while the keyboard is up.
  useEffect(() => {
    setSel({ typing });
  }, [typing]);
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidHide", () => {
      liveRef.current?.blur();
      setTyping(false);
    });
    return () => {
      sub.remove();
      setSel({ typing: false });
    };
  }, []);
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

  // Paste = Ctrl+V on the PC. (Replaces the old "Send" key, which only
  // fired the held modifiers and did nothing otherwise: typed text already
  // goes to the PC live, and Enter comes from the phone keyboard.)
  function paste() {
    send(msg.combo(["ctrl", "v"]));
  }

  // ---- Ketik langsung ----
  function sendLive(added, removed) {
    for (let i = 0; i < Math.min(removed, 50); i += 1) send(msg.key("backspace"));
    if (!added) return;
    if (held.length) {
      // Held Ctrl/Alt/Shift/Win + a char = a real chord (Listary Ctrl+Shift+Alt+/).
      let rest = "";
      for (const ch of added) {
        const k = chordKey(ch);
        if (k) send(msg.combo([...held, k]));
        else rest += ch;
      }
      if (rest) send(msg.text(rest, true));
      return;
    }
    send(msg.text(added, true));
  }
  function handleLiveChange(t) {
    const { removed, added } = diffInput(liveVal.current, t);
    sendLive(added, removed);
    setRecent((r) => pushRecent(r, added, removed));
    // Reset to a fresh sentinel so the next Backspace still has something to eat.
    const nextSentinel = liveVal.current === SENTINELS[0] ? SENTINELS[1] : SENTINELS[0];
    liveVal.current = nextSentinel;
    setLiveText(nextSentinel);
  }
  function startLive() {
    setRecent("");
    setTyping(true);
    setTimeout(() => liveRef.current?.focus(), 30);
  }
  function stopLive() {
    liveRef.current?.blur();
    Keyboard.dismiss();
    setTyping(false);
  }

  function sendField() {
    if (!free) return;
    send(msg.text(free));
    setFree("");
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
    { label: "Paste", onPress: paste },
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
      <ViewerPanel
        title="Type"
        touchpad={false}
        actions={false}
        overlay={
          <>
            {/* Hidden input that carries the phone keyboard. Always mounted so
                hiding the control area never drops the keyboard. */}
            <TextInput
              ref={liveRef}
              style={styles.hiddenInput}
              value={liveText}
              onChangeText={handleLiveChange}
              onSubmitEditing={() => {
                sendLive("\n", 0);
                setRecent((r) => pushRecent(r, "\n", 0));
              }}
              onBlur={() => setTyping(false)}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              keyboardType="visible-password"
              importantForAutofill="no"
              blurOnSubmit={false}
              submitBehavior="submit"
              returnKeyType="default"
              caretHidden
              contextMenuHidden
            />
            {typing && (
              <Block style={styles.pill}>
                <View style={styles.pillDot} />
                <Text style={styles.pillRecent} numberOfLines={1}>{heldHint || recent.split("").join(" ") || "Mengetik ke PC"}</Text>
                <Pressable onPress={() => tapModifier("ctrl")} style={[styles.pillKey, held.includes("ctrl") && styles.keyActive]} hitSlop={4}>
                  <Text style={styles.pillKeyText}>Ctrl</Text>
                </Pressable>
                <Pressable onPress={() => tapKey("esc")} style={styles.pillKey} hitSlop={4}>
                  <Text style={styles.pillKeyText}>Esc</Text>
                </Pressable>
                <Pressable onPress={stopLive} style={styles.pillKey} hitSlop={4} accessibilityLabel="Tutup keyboard">
                  <MaterialCommunityIcons name="chevron-down" size={18} color={COLORS.text} />
                </Pressable>
              </Block>
            )}
          </>
        }
      >
        <View style={styles.freeRow}>
          {mode === "live" ? (
            <Pressable onPress={startLive} style={({ pressed }) => [styles.liveBtn, pressed && styles.keyPressed]} accessibilityLabel="Ketik langsung ke PC">
              <MaterialCommunityIcons name="keyboard-outline" size={18} color="#ffffff" />
              <Text style={styles.liveBtnText}>{heldHint ? `Ketik langsung · ${heldHint}` : "Ketik langsung"}</Text>
            </Pressable>
          ) : (
            <>
              <TextInput
                style={styles.free}
                value={free}
                onChangeText={setFree}
                onSubmitEditing={sendField}
                placeholder="Teks panjang, lalu Kirim"
                placeholderTextColor={COLORS.muted}
                autoCapitalize="none"
                autoCorrect={false}
                blurOnSubmit={false}
                returnKeyType="send"
                submitBehavior="submit"
              />
              <Pressable onPress={sendField} style={[styles.sendBtn, !free && styles.sendBtnOff]} accessibilityLabel="Kirim teks ke PC">
                <Text style={styles.liveBtnText}>Kirim</Text>
              </Pressable>
            </>
          )}
          <Pressable
            onPress={() => setMode(mode === "live" ? "field" : "live")}
            style={styles.modeBtn}
            accessibilityLabel={mode === "live" ? "Ganti ke kolom teks" : "Ganti ke ketik langsung"}
          >
            <MaterialCommunityIcons name={mode === "live" ? "form-textbox" : "keyboard-outline"} size={18} color={COLORS.text} />
          </Pressable>
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
  keyAccent: { backgroundColor: "#4b49c9" },
  keyActive: { backgroundColor: "#5e5ce6", borderWidth: 1, borderColor: COLORS.accent },
  keyPressed: { opacity: 0.6 },
  keyText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  keyTextActive: { color: COLORS.accent },
  free: { flex: 1, height: FIELD_H, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 0 },
  freeRow: { flexDirection: "row", gap: 6, alignItems: "center", height: FIELD_H },
  liveBtn: { flex: 1, height: FIELD_H, borderRadius: 10, backgroundColor: "#5e5ce6", flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  liveBtnText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  sendBtn: { height: FIELD_H, paddingHorizontal: 14, borderRadius: 10, backgroundColor: "#5e5ce6", alignItems: "center", justifyContent: "center" },
  sendBtnOff: { opacity: 0.5 },
  modeBtn: { width: FIELD_H, height: FIELD_H, borderRadius: 10, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  hiddenInput: { position: "absolute", left: 0, bottom: 0, width: 2, height: 2, opacity: 0, color: "transparent" },
  pill: { position: "absolute", right: 8, bottom: 8, maxWidth: "92%", flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 10, paddingRight: 4, paddingVertical: 4, borderRadius: 18, backgroundColor: "rgba(18,18,20,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.14)" },
  pillDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#34c759" },
  pillRecent: { color: COLORS.muted, fontSize: 11, maxWidth: 110, marginHorizontal: 4 },
  pillKey: { minWidth: 40, height: 28, paddingHorizontal: 8, borderRadius: 14, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  pillKeyText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
});
