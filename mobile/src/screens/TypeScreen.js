/** TYPE (layout C, v2): shared viewer on top, fixed control area below:
 *   row 0: big "Ketik ke PC" button (default) or "Kolom teks" field + Kirim,
 *          mode toggle at the right
 *     - Ketik langsung: opens the phone keyboard (normal layout; "123" in the
 *       typing bar switches to the number-row keyboard) on a hidden input;
 *       every key goes to the PC at once as REAL key presses.
 *       While typing, the viewer chrome hides: a typing bar on top shows what
 *       already went to the PC (+ caret) and the quick keys dock at the bottom
 *       of the viewer, right above the phone keyboard.
 *     - Kolom teks: type into a field, "Kirim" sends it as Unicode (long text).
 *   rows 1-2 (fixed, never scroll): Esc Tab Ctrl Alt Shift Win ⋯ /
 *          Bksp Enter ← ↑ ↓ →; ⋯ flips row 1 to Del Home End PgUp PgDn Ins
 *          Paste. Docked above the keyboard: one row Esc Tab Ctrl Alt Shift ⋯
 *          ← ↑ ↓ → (⋯ = Win Del Home End Paste).
 *          Ctrl/Alt/Shift/Win: tap = held for the NEXT key only (released
 *          after it), long press = locked until tapped again.
 *   row 2: history & favourites of texts sent with Kolom teks; tap = send,
 *          long press = favourite / delete. (Live typing is never recorded:
 *          it is where passwords get typed.)
 * Protocol/functions preserved: key tap, down-only hold, combo chords, text.
 */
import React, { useEffect, useRef, useState } from "react";
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Text from "../AppText";
import { COLORS } from "../components";
import { Block } from "../viewer";
import { useViewerSlot } from "../viewerslot";
import { setSel } from "../controls";
import { SENTINELS, chordKey, liveDiff, nextSentinel, pushRecent } from "../typediff";
import { rowHeight } from "../tablayout";
import { registerSetting, settingChanged } from "../settingsync";
import { msg } from "../protocol";
import { addListener, send } from "../connection";
import { setCaretFollow, useCaretPref } from "../caretpref";

const MODS = ["ctrl", "alt", "shift", "win"];
const FIELD_H = 44;
const KEY_H = 38;
const DOCK_H = 40;
const SNIP_H = rowHeight(1, [FIELD_H, KEY_H, KEY_H]);
// Last key page (A = Esc/Tab/modifiers, B = Del/Home/End/...) survives tab switches.
let lastPage = "A";
const STORE_TYPE = "pcremote.type"; // { mode: "live" | "field", hold: bool, kb: "text" | "num" }
// kb "text": normal phone keyboard (numbers behind ?123, no suggestions).
// kb "num": the old visible-password keyboard (fixed number row, never
// predicts) - fallback for keyboards that still compose words.
// hold: kept for settings sync with older versions (modifiers are one-shot
// with long-press lock since v2).
const pref = { mode: "live", hold: true, kb: "text", loaded: false };
const RECENT_MAX = 40;
const prefListeners = new Set();
function storePref() {
  SecureStore.setItemAsync(STORE_TYPE, JSON.stringify({ mode: pref.mode, hold: pref.hold, kb: pref.kb })).catch(() => {});
}
function savePref() {
  storePref();
  settingChanged("type", { mode: pref.mode, hold: pref.hold, kb: pref.kb });
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
    if (v.kb === "text" || v.kb === "num") pref.kb = v.kb;
    pref.loaded = true;
    storePref();
    for (const l of [...prefListeners]) l();
  },
});

// ---- History & favourites (texts sent with Kolom teks) ----
const STORE_SNIPS = "pcremote.snips"; // [{ t: string, fav: bool }]
const SNIP_MAX = 12; // non-favourite entries kept
const SNIP_LEN = 500;
function normSnips(list) {
  const arr = Array.isArray(list) ? list.filter((s) => s && typeof s.t === "string" && s.t) : [];
  const favs = arr.filter((s) => s.fav);
  const rest = arr.filter((s) => !s.fav).slice(0, SNIP_MAX);
  return [...favs, ...rest].map((s) => ({ t: s.t.slice(0, SNIP_LEN), fav: !!s.fav }));
}
function addSnip(list, text) {
  const t = String(text || "").slice(0, SNIP_LEN);
  if (!t.trim()) return list;
  const old = list.find((s) => s.t === t);
  const others = list.filter((s) => s.t !== t);
  return normSnips([{ t, fav: !!old?.fav }, ...others]);
}
function snipLabel(t) {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > 24 ? one.slice(0, 23) + "…" : one;
}

export default function TypeScreen() {
  const [held, setHeld] = useState([]);
  const [locked, setLocked] = useState([]);
  const [mode, setModeState] = useState(pref.mode);
  const [kb, setKbState] = useState(pref.kb);
  const [free, setFree] = useState("");
  const [typing, setTyping] = useState(false);
  const [recent, setRecent] = useState("");
  const [page, setPageState] = useState(lastPage);
  function setPage(v) {
    lastPage = v;
    setPageState(v);
  }
  const [snips, setSnipsState] = useState([]);
  const liveRef = useRef(null);
  const liveVal = useRef(SENTINELS[0]);
  const liveSentinel = useRef(SENTINELS[1]); // the reset we last asked for
  const [liveText, setLiveText] = useState(SENTINELS[0]);
  function setKb(v) {
    pref.kb = v;
    savePref();
    setKbState(v);
  }
  function setMode(v) {
    pref.mode = v;
    savePref();
    setModeState(v);
  }
  function setSnips(next) {
    setSnipsState(next);
    SecureStore.setItemAsync(STORE_SNIPS, JSON.stringify(next)).catch(() => {});
  }
  // Saved choices (mode, keyboard) survive restarts.
  useEffect(() => {
    SecureStore.getItemAsync(STORE_SNIPS)
      .then((raw) => setSnipsState(normSnips(raw ? JSON.parse(raw) : [])))
      .catch(() => {});
    if (pref.loaded) return;
    SecureStore.getItemAsync(STORE_TYPE)
      .then((raw) => {
        pref.loaded = true;
        const v = raw ? JSON.parse(raw) : null;
        if (v && (v.mode === "live" || v.mode === "field")) {
          pref.mode = v.mode;
          setModeState(v.mode);
        }
        if (v && typeof v.hold === "boolean") pref.hold = v.hold;
        if (v && (v.kb === "text" || v.kb === "num")) {
          pref.kb = v.kb;
          setKbState(v.kb);
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
      setKbState(pref.kb);
    };
    prefListeners.add(onPref);
    return () => prefListeners.delete(onPref);
  }, []);
  // Live typing owns the viewer chrome while the keyboard is up.
  useEffect(() => {
    setSel({ typing });
  }, [typing]);
  // "Zoom ikut teks": the PC reports the caret only while we type with it on
  // (again after a reconnect, the new socket starts with it off).
  const caretPref = useCaretPref();
  const wantCaret = typing && caretPref.follow;
  useEffect(() => {
    send(msg.caretWatch(wantCaret));
    if (!wantCaret) return undefined;
    const off = addListener((e) => {
      if (e.t === "hello") send(msg.caretWatch(true));
    });
    return () => {
      off();
      send(msg.caretWatch(false));
    };
  }, [wantCaret]);
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
  // Modifier cleanup: held Ctrl/Alt/Shift/Win must never stay down on the PC
  // after unmount, socket close, or across a reconnect.
  const heldRef = useRef([]);
  heldRef.current = held;
  const lockedRef = useRef([]);
  lockedRef.current = locked;
  useEffect(() => {
    const off = addListener((event) => {
      if (event.t === "close" && heldRef.current.length) {
        send(msg.combo([...heldRef.current], false, true)); // best-effort
      }
      if (event.t === "hello" && heldRef.current.length) {
        send(msg.combo([...heldRef.current], false, true));
        setHeld([]);
        setLocked([]);
      }
    });
    return () => {
      off();
      if (heldRef.current.length) send(msg.combo([...heldRef.current], false, true));
    };
  }, []);

  // Set the modifiers that are down on the PC to exactly `next`.
  function setDown(next) {
    const cur = heldRef.current;
    if (cur.length) send(msg.combo([...cur], false, true)); // release all
    if (next.length) send(msg.combo(next, true, false)); // re-hold the rest
    heldRef.current = next;
    setHeld(next);
  }

  // After a key/char went out with modifiers: one-shot ones let go, locked stay.
  function afterKey() {
    const cur = heldRef.current;
    if (!cur.length) return;
    const keep = cur.filter((k) => lockedRef.current.includes(k));
    if (keep.length !== cur.length) setDown(keep);
  }

  function tapKey(key) {
    const cur = heldRef.current;
    if (cur.length) {
      // chord: held modifiers + this key
      send(msg.combo([...cur, key]));
      afterKey();
      return;
    }
    send(msg.key(key));
  }

  function tapModifier(key) {
    const cur = heldRef.current;
    if (cur.includes(key)) {
      setLocked((l) => l.filter((k) => k !== key));
      lockedRef.current = lockedRef.current.filter((k) => k !== key);
      setDown(cur.filter((k) => k !== key));
      return;
    }
    send(msg.key(key, true, undefined)); // down only
    const next = [...cur, key];
    heldRef.current = next;
    setHeld(next);
  }

  function lockModifier(key) {
    if (!heldRef.current.includes(key)) tapModifier(key);
    if (!lockedRef.current.includes(key)) {
      lockedRef.current = [...lockedRef.current, key];
      setLocked(lockedRef.current);
    }
  }

  // Paste = Ctrl+V on the PC.
  function paste() {
    send(msg.combo(["ctrl", "v"]));
  }

  // ---- Ketik langsung ----
  function sendLive(added, removed) {
    for (let i = 0; i < Math.min(removed, 50); i += 1) send(msg.key("backspace"));
    if (!added) return;
    const cur = heldRef.current;
    if (cur.length) {
      // Held Ctrl/Alt/Shift/Win + a char = a real chord (Listary Ctrl+Shift+Alt+/).
      let rest = "";
      for (const ch of added) {
        const k = chordKey(ch);
        if (k) send(msg.combo([...cur, k]));
        else rest += ch;
      }
      if (rest) send(msg.text(rest, true));
      afterKey();
      return;
    }
    send(msg.text(added, true));
  }
  function handleLiveChange(t) {
    // liveVal = what the native field really holds (last onChangeText), which
    // may still be the old text if our sentinel reset has not landed yet.
    const { removed, added } = liveDiff(liveVal.current, t, liveSentinel.current);
    liveVal.current = t;
    if (!removed && !added) return;
    sendLive(added, removed);
    setRecent((r) => pushRecent(r, added, removed, RECENT_MAX));
    // Reset to a fresh sentinel so the next Backspace still has something to eat.
    const reset = nextSentinel(t);
    liveSentinel.current = reset;
    setLiveText(reset);
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
    setSnips(addSnip(snips, free));
    setFree("");
  }

  function snipMenu(s) {
    Alert.alert(snipLabel(s.t), undefined, [
      {
        text: s.fav ? "Hapus dari favorit" : "★ Jadikan favorit",
        onPress: () => setSnips(normSnips(snips.map((x) => (x.t === s.t ? { ...x, fav: !x.fav } : x)))),
      },
      { text: "Hapus", style: "destructive", onPress: () => setSnips(snips.filter((x) => x.t !== s.t)) },
      { text: "Batal", style: "cancel" },
    ]);
  }

  const modLabel = (k) => k[0].toUpperCase() + k.slice(1);
  // Every key by id; rows below only list ids, so no row ever scrolls.
  const K = {
    esc: { label: "Esc", onPress: () => tapKey("esc") },
    tab: { label: "Tab", onPress: () => tapKey("tab") },
    enter: { label: "Enter", onPress: () => tapKey("enter") },
    bksp: { label: "Bksp", onPress: () => tapKey("backspace") },
    del: { label: "Del", onPress: () => tapKey("delete") },
    home: { label: "Home", onPress: () => tapKey("home") },
    end: { label: "End", onPress: () => tapKey("end") },
    pgup: { label: "PgUp", onPress: () => tapKey("pageup") },
    pgdn: { label: "PgDn", onPress: () => tapKey("pagedown") },
    ins: { label: "Ins", onPress: () => tapKey("insert") },
    paste: { label: "Paste", onPress: paste },
    left: { icon: "arrow-left", a11y: "Panah kiri", arrow: true, onPress: () => tapKey("left") },
    up: { icon: "arrow-up", a11y: "Panah atas", arrow: true, onPress: () => tapKey("up") },
    down: { icon: "arrow-down", a11y: "Panah bawah", arrow: true, onPress: () => tapKey("down") },
    right: { icon: "arrow-right", a11y: "Panah kanan", arrow: true, onPress: () => tapKey("right") },
    more: { label: page === "B" ? "abc" : "⋯", a11y: page === "B" ? "Tombol utama" : "Tombol lainnya", on: page === "B", onPress: () => setPage(page === "B" ? "A" : "B") },
  };
  for (const m of MODS) {
    K[m] = {
      label: modLabel(m),
      on: held.includes(m),
      lock: locked.includes(m),
      onPress: () => tapModifier(m),
      onLongPress: () => lockModifier(m),
    };
  }
  const ARROWS = ["left", "up", "down", "right"];
  // Keyboard closed: two rows. Keyboard open: one row docked above it.
  const ROW_TOP = page === "B" ? ["del", "home", "end", "pgup", "pgdn", "ins", "paste", "more"] : ["esc", "tab", "ctrl", "alt", "shift", "win", "more"];
  const ROW_BOTTOM = ["bksp", "enter", ...ARROWS];
  const ROW_DOCK = [...(page === "B" ? ["win", "del", "home", "end", "paste"] : ["esc", "tab", "ctrl", "alt", "shift"]), "more", ...ARROWS];

  function renderRow(ids, h, small) {
    return (
      <View style={[styles.keyRow, { height: h }]}>
        {ids.map((id) => {
          const k = K[id];
          return (
            <Pressable
              key={id}
              onPress={k.onPress}
              onLongPress={k.onLongPress}
              delayLongPress={380}
              hitSlop={2}
              accessibilityLabel={k.a11y || (k.lock ? `${k.label} terkunci` : k.label)}
              style={({ pressed }) => [styles.key, k.arrow && styles.keyArrow, k.on && styles.keyActive, pressed && styles.keyPressed]}
            >
              {k.icon ? (
                <MaterialCommunityIcons name={k.icon} size={16} color={COLORS.text} />
              ) : (
                <Text style={[styles.keyText, small && styles.keyTextSmall, k.on && styles.keyTextActive]} numberOfLines={1}>
                  {k.label}
                </Text>
              )}
              {k.lock && <MaterialCommunityIcons name="lock" size={9} color="#ffffff" style={styles.keyLock} />}
            </Pressable>
          );
        })}
      </View>
    );
  }

  const heldHint = held.length ? held.map(modLabel).join("+") + " + …" : null;

  const overlay = (
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
                setRecent((r) => pushRecent(r, "\n", 0, RECENT_MAX));
              }}
              onBlur={() => setTyping(false)}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              keyboardType={kb === "num" ? "visible-password" : "default"}
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
                {/* What already went to the PC, newest at the right; the head
                    is cut first so the caret end always stays visible. */}
                <Text style={styles.pillRecent} numberOfLines={1} ellipsizeMode="head">
                  {heldHint ? (
                    <Text style={styles.pillHeld}>{heldHint}</Text>
                  ) : recent ? (
                    recent
                  ) : (
                    <Text style={styles.pillIdle}>Mengetik ke PC</Text>
                  )}
                  <Text style={styles.pillCaret}>▏</Text>
                </Text>
                <Pressable
                  onPress={() => setKb(kb === "num" ? "text" : "num")}
                  style={[styles.pillKey, kb === "num" && styles.keyActive]}
                  hitSlop={4}
                  accessibilityLabel={kb === "num" ? "Keyboard biasa" : "Keyboard dengan baris angka"}
                >
                  <Text style={styles.pillKeyText}>123</Text>
                </Pressable>
                <Pressable
                  onPress={() => setCaretFollow(!caretPref.follow)}
                  style={[styles.pillKey, caretPref.follow && styles.keyActive]}
                  hitSlop={4}
                  accessibilityLabel={caretPref.follow ? "Zoom ikut teks: nyala" : "Zoom ikut teks: mati"}
                >
                  <MaterialCommunityIcons name={caretPref.follow ? "magnify-scan" : "magnify-remove-outline"} size={18} color={COLORS.text} />
                </Pressable>
                <Pressable onPress={stopLive} style={styles.pillKey} hitSlop={4} accessibilityLabel="Tutup keyboard">
                  <MaterialCommunityIcons name="chevron-down" size={18} color={COLORS.text} />
                </Pressable>
              </Block>
            )}
            {typing && (
              <Block style={styles.dock}>
                {renderRow(ROW_DOCK, DOCK_H, true)}
              </Block>
            )}
          </>
  );
  const controls = (
    <>
        <View style={styles.freeRow}>
          {mode === "live" ? (
            <Pressable onPress={startLive} style={({ pressed }) => [styles.liveBtn, pressed && styles.keyPressed]} accessibilityLabel="Ketik langsung ke PC">
              <MaterialCommunityIcons name="keyboard-outline" size={20} color="#ffffff" />
              <Text style={styles.liveBtnText}>{heldHint ? `Ketik ke PC · ${heldHint}` : "Ketik ke PC"}</Text>
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
            <MaterialCommunityIcons name={mode === "live" ? "form-textbox" : "keyboard-outline"} size={20} color={COLORS.text} />
          </Pressable>
        </View>
        {renderRow(ROW_TOP, KEY_H)}
        {renderRow(ROW_BOTTOM, KEY_H)}
        <View style={[styles.snipArea, { height: SNIP_H }]}>
          {snips.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.snipRow}>
              {snips.map((s) => (
                <Pressable
                  key={s.t}
                  onPress={() => send(msg.text(s.t))}
                  onLongPress={() => snipMenu(s)}
                  delayLongPress={380}
                  style={({ pressed }) => [styles.snip, pressed && styles.keyPressed]}
                  accessibilityLabel={`Kirim: ${snipLabel(s.t)}`}
                >
                  <MaterialCommunityIcons name={s.fav ? "star" : "history"} size={15} color={s.fav ? "#facc15" : COLORS.muted} />
                  <Text style={styles.snipText} numberOfLines={1}>{snipLabel(s.t)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.snipEmpty} numberOfLines={2}>
              Teks yang dikirim lewat kolom teks muncul di sini. Tap = kirim lagi, tahan = ★ favorit.
            </Text>
          )}
        </View>
    </>
  );
  useViewerSlot("Type", { title: "Type", overlay, controls });
  return null;
}

const styles = StyleSheet.create({
  keyActive: { backgroundColor: "#5e5ce6", borderWidth: 1, borderColor: COLORS.accent },
  keyPressed: { opacity: 0.6 },
  keyText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  keyTextActive: { color: "#ffffff" },
  free: { flex: 1, height: FIELD_H, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 0 },
  freeRow: { flexDirection: "row", gap: 6, alignItems: "center", height: FIELD_H },
  liveBtn: { flex: 1, height: FIELD_H, borderRadius: 12, backgroundColor: "#5e5ce6", flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  liveBtnText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  sendBtn: { height: FIELD_H, paddingHorizontal: 16, borderRadius: 10, backgroundColor: "#5e5ce6", alignItems: "center", justifyContent: "center" },
  sendBtnOff: { opacity: 0.5 },
  modeBtn: { width: FIELD_H, height: FIELD_H, borderRadius: 12, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  // Fixed rows: text keys share the width, arrows stay narrow. Never scrolls.
  keyRow: { flexDirection: "row", gap: 4 },
  key: { flex: 1, minWidth: 0, borderRadius: 9, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center", paddingHorizontal: 1 },
  keyArrow: { flex: 0, width: 32 },
  keyTextSmall: { fontSize: 11 },
  keyLock: { position: "absolute", top: 2, right: 3 },
  snipArea: { justifyContent: "center" },
  snipRow: { flexDirection: "row", gap: 6, alignItems: "center" },
  snip: { flexDirection: "row", alignItems: "center", gap: 6, height: SNIP_H, paddingHorizontal: 12, borderRadius: 18, backgroundColor: COLORS.card, maxWidth: 220 },
  snipText: { color: COLORS.text, fontSize: 12, fontWeight: "600", flexShrink: 1 },
  snipEmpty: { color: COLORS.muted, fontSize: 11 },
  hiddenInput: { position: "absolute", left: 0, bottom: 0, width: 2, height: 2, opacity: 0, color: "transparent" },
  // Top: the field being typed into usually sits at the bottom of the view.
  pill: { position: "absolute", left: 8, right: 8, top: 8, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 10, paddingRight: 4, paddingVertical: 4, borderRadius: 18, backgroundColor: "rgba(18,18,20,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.14)" },
  pillDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#34c759" },
  pillRecent: { flex: 1, color: COLORS.text, fontSize: 13, marginHorizontal: 4 },
  pillIdle: { color: COLORS.muted },
  pillHeld: { color: COLORS.accent, fontWeight: "700" },
  pillCaret: { color: "#34c759", fontWeight: "700" },
  pillKey: { minWidth: 40, height: 28, paddingHorizontal: 8, borderRadius: 14, backgroundColor: COLORS.chip, alignItems: "center", justifyContent: "center" },
  pillKeyText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  // Quick keys docked at the bottom of the viewer = right above the keyboard.
  dock: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 6, paddingVertical: 4, backgroundColor: "rgba(20,20,22,0.96)", borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
});
