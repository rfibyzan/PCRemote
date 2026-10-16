/** WIN (layout C): shared viewer + fixed control area: section tabs
 * (Sistem | Edit | Media | Fn | Pintasan | Lainnya) over two rows of buttons. Every
 * section fits in those two rows except Lainnya, which scrolls inside the
 * area (the area itself never grows, so the viewer stays the same size). */
import React, { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Text from "../AppText";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { COLORS } from "../components";
import ViewerPanel from "../viewer";
import { rowHeight } from "../tablayout";
import { msg } from "../protocol";
import { addListener, send } from "../connection";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import ShortcutEditor from "../shortcuteditor";
import { PressScale, SlideTabs, popIn } from "../motion";
import { useShortcuts, saveShortcuts } from "../shortcuts";
import { comboKeys, comboLabel, moveShortcut, removeShortcut, upsertShortcut, MAX_SHORTCUTS } from "../shortcutmath";

// Shortcut tiles slide into place when one is added, moved or removed.
const SC_LAYOUT = LinearTransition.springify().damping(18).stiffness(220);

const APPS = [
  { id: "explorer", label: "Files", icon: "folder" },
  { id: "taskmgr", label: "Task", icon: "assessment" },
  { id: "notepad", label: "Notes", icon: "description" },
  { id: "terminal", label: "Term", icon: "terminal" },
  { id: "browser", label: "Web", icon: "public" },
  { id: "settings", label: "Set", icon: "settings" },
  { id: "calc", label: "Calc", icon: "calculate" },
];
const MEDIA = [
  { a: "pause", icon: "pause" },
  { a: "stop", icon: "stop" },
  { a: "prev", icon: "skip-previous" },
  { a: "next", icon: "skip-next" },
  { a: "mute", icon: "volume-mute" },
  { a: "voldown", icon: "volume-down" },
  { a: "volup", icon: "volume-up" },
];
const FKEYS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"];
const SECTIONS = ["Sistem", "Edit", "Media", "Fn", "Pintasan", "Lainnya"];
// Last section survives tab switches (WIN stays mounted, but keep it explicit).
let lastSection = "Sistem";
const TABS_H = 28;
const CELL_H = rowHeight(2, [TABS_H]);
// Bigger touch target without bigger visuals (Win buttons are Type-small).
// Horizontal slop stays <= gap (3px) so adjacent buttons never overlap and
// RN can't pick the wrong one; vertical gets a bit more (rows are taller).
const HIT = { top: 4, bottom: 4, left: 2, right: 2 };

export default function WinScreen() {
  const [clip, setClip] = useState("");
  const [url, setUrl] = useState("");
  const [field, setField] = useState("url");
  const [section, setSectionState] = useState(lastSection);
  function setSection(v) {
    lastSection = v;
    setSectionState(v);
  }
  // Apps = Alt+Tab switcher hold: first tap opens and HOLDS Alt, second tap
  // (Apps again or any viewer tap) releases to confirm the selection.
  const [appsHeld, setAppsHeld] = useState(false);
  const appsHeldRef = useRef(false);
  const fetchClipAt = useRef(0);
  // Custom shortcuts: tap = send combo, hold = Edit / Geser / Hapus.
  const shortcuts = useShortcuts();
  const [editing, setEditing] = useState(null); // null | {} (new) | shortcut

  function saveEdit(draft) {
    saveShortcuts(upsertShortcut(shortcuts, draft));
    setEditing(null);
  }
  function deleteShortcut(sc) {
    Alert.alert("Hapus pintasan?", `${sc.name} (${comboLabel(sc)})`, [
      { text: "Batal", style: "cancel" },
      { text: "Hapus", style: "destructive", onPress: () => { saveShortcuts(removeShortcut(shortcuts, sc.id)); setEditing(null); } },
    ]);
  }
  function shortcutMenu(sc) {
    Alert.alert(sc.name, comboLabel(sc), [
      { text: "Edit", onPress: () => setEditing(sc) },
      { text: "Geser kiri", onPress: () => saveShortcuts(moveShortcut(shortcuts, sc.id, -1)) },
      { text: "Geser kanan", onPress: () => saveShortcuts(moveShortcut(shortcuts, sc.id, 1)) },
      { text: "Hapus", style: "destructive", onPress: () => deleteShortcut(sc) },
      { text: "Batal", style: "cancel" },
    ]);
  }

  function releaseApps() {
    if (!appsHeldRef.current) return;
    appsHeldRef.current = false;
    setAppsHeld(false);
    send(msg.combo(["alt", "tab"], false, true));
  }

  function tapApps() {
    if (appsHeldRef.current) {
      releaseApps();
      return;
    }
    appsHeldRef.current = true;
    setAppsHeld(true);
    send(msg.combo(["alt", "tab"], true, false));
  }

  useEffect(() => {
    // Clipboard fetch throttled: remounts on every tab visit must not spam
    // the PC with back-to-back clipboard reads.
    const now = Date.now();
    if (now - (fetchClipAt.current || 0) > 5000) {
      fetchClipAt.current = now;
      send(msg.clipboard());
    }
    const off = addListener((event) => {
      if (event.t === "clipboard" && typeof event.s === "string") setClip(event.s);
      if (event.t === "close" && appsHeldRef.current) {
        appsHeldRef.current = false;
        setAppsHeld(false);
      }
    });
    return () => {
      off();
      if (appsHeldRef.current) send(msg.combo(["alt", "tab"], false, true)); // never leave Alt stuck
    };
  }, []);

  function Btn({ label, icon, onPress, active, danger, wide, fn, small, a11y }) {
    return (
      <PressScale
        onPress={onPress}
        hitSlop={HIT}
        accessibilityLabel={a11y || label}
        style={({ pressed }) => [styles.cell, fn && styles.cellFn, small && styles.cellSmall, wide && styles.cellWide, active && styles.cellActive, danger && styles.dangerCell, pressed && styles.cellPressed]}
      >
        {icon ? <MaterialIcons name={icon} size={16} color={COLORS.text} /> : null}
        {label ? <Text style={[styles.cellText, active && styles.cellTextActive]} numberOfLines={1}>{label}</Text> : null}
      </PressScale>
    );
  }

  return (
    <LayoutAnimationConfig skipEntering>
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ViewerPanel title="Win" touchpad={false} actions={false} onTap={releaseApps}>
      <SlideTabs
        items={SECTIONS}
        value={section}
        onChange={setSection}
        style={styles.tabs}
        tabStyle={styles.tab}
        activeColor={styles.tabActive.backgroundColor}
        renderLabel={(sec, on) => <Text style={[styles.tabText, on && styles.tabTextActive]}>{sec}</Text>}
      />
      <Animated.View key={section} entering={FadeIn.duration(150)} style={styles.ctl}>
        {section === "Sistem" && (
          <View style={styles.grid}>
            <Btn icon="apps" label="Start" onPress={() => send(msg.key("win"))} />
            <Btn icon="swap-horiz" label="Apps" active={appsHeld} onPress={tapApps} />
            <Btn icon="view-carousel" label="Task View" onPress={() => send(msg.combo(["win", "tab"]))} />
            <Btn icon="desktop-windows" label="Desktop" onPress={() => send(msg.combo(["win", "d"]))} />
            <Btn icon="close" label="Close" onPress={() => send(msg.combo(["alt", "f4"]))} />
            <Btn icon="keyboard-return" label="Esc" onPress={() => send(msg.key("esc"))} />
            <Btn icon="folder" label="Files" onPress={() => send(msg.open("explorer"))} />
            <Btn icon="public" label="Browser" onPress={() => send(msg.open("browser"))} />
            <Btn icon="lock" label="Lock" danger a11y="Lock PC" onPress={() => send(msg.lock())} />
          </View>
        )}
        {section === "Edit" && (
          <View style={styles.grid}>
            <Btn icon="content-copy" label="Copy" onPress={() => send(msg.combo(["ctrl", "c"]))} />
            <Btn icon="content-paste" label="Paste" onPress={() => send(msg.combo(["ctrl", "v"]))} />
            <Btn icon="content-cut" label="Cut" onPress={() => send(msg.combo(["ctrl", "x"]))} />
            <Btn icon="select-all" label="Select all" onPress={() => send(msg.combo(["ctrl", "a"]))} />
            <Btn icon="undo" label="Undo" onPress={() => send(msg.combo(["ctrl", "z"]))} />
            <Btn icon="redo" label="Redo" onPress={() => send(msg.combo(["ctrl", "y"]))} />
            <Btn icon="save" label="Save" onPress={() => send(msg.combo(["ctrl", "s"]))} />
            <Btn icon="search" label="Find" onPress={() => send(msg.combo(["ctrl", "f"]))} />
          </View>
        )}
        {section === "Media" && (
          <View style={styles.grid}>
            {MEDIA.map((m) => (
              <Btn key={m.a} icon={m.icon} a11y={m.a} onPress={() => send(msg.media(m.a))} />
            ))}
          </View>
        )}
        {section === "Fn" && (
          <View style={styles.grid}>
            {FKEYS.map((k) => (
              <Btn key={k} label={k.toUpperCase()} fn onPress={() => send(msg.key(k))} />
            ))}
          </View>
        )}
        {section === "Pintasan" && (
          <ScrollView contentContainerStyle={styles.grid} nestedScrollEnabled showsVerticalScrollIndicator={false}>
            {shortcuts.map((sc) => (
              <Animated.View key={sc.id} entering={popIn} exiting={FadeOut.duration(150)} layout={SC_LAYOUT} style={styles.scWrap}>
              <PressScale
                onPress={() => send(msg.combo(comboKeys(sc)))}
                onLongPress={() => shortcutMenu(sc)}
                delayLongPress={380}
                hitSlop={HIT}
                accessibilityLabel={`${sc.name}, ${comboLabel(sc)}`}
                style={({ pressed }) => [styles.cell, styles.scCell, styles.scFill, pressed && styles.cellPressed]}
              >
                <Text style={styles.scName} numberOfLines={1}>{sc.name}</Text>
                <Text style={styles.scCombo} numberOfLines={1}>{comboLabel(sc)}</Text>
              </PressScale>
              </Animated.View>
            ))}
            {shortcuts.length < MAX_SHORTCUTS ? (
              <Animated.View key="__add" layout={SC_LAYOUT} style={styles.scWrap}>
              <PressScale onPress={() => setEditing({})} hitSlop={HIT} style={({ pressed }) => [styles.cell, styles.scCell, styles.scAdd, styles.scFill, pressed && styles.cellPressed]}>
                <MaterialIcons name="add" size={16} color={COLORS.accent} />
                <Text style={styles.scAddText}>{shortcuts.length ? "Tambah" : "Tambah pintasan"}</Text>
              </PressScale>
              </Animated.View>
            ) : null}
          </ScrollView>
        )}
        {section === "Lainnya" && (
          <View style={styles.more}>
            <View style={styles.grid}>
              {APPS.map((a) => (
                <Btn key={a.id} icon={a.icon} label={a.label} small a11y={a.id} onPress={() => send(msg.open(a.id))} />
              ))}
            </View>
            {/* One input row for both: URL to open, or the PC clipboard. */}
            <View style={[styles.row, { height: CELL_H }]}>
              <Pressable onPress={() => setField(field === "url" ? "clip" : "url")} hitSlop={HIT} style={[styles.go, styles.goAlt]}>
                <Text style={styles.goText}>{field === "url" ? "URL" : "Clip"} ⇄</Text>
              </Pressable>
              {field === "url" ? (
                <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="https://…" placeholderTextColor={COLORS.muted} autoCapitalize="none" />
              ) : (
                <TextInput style={styles.input} value={clip} onChangeText={setClip} placeholder="Clipboard PC (kosong)" placeholderTextColor={COLORS.muted} />
              )}
              {field === "url" ? (
                <Pressable onPress={() => url.trim() && send(msg.open(url.trim()))} hitSlop={HIT} style={styles.go}>
                  <Text style={styles.goText}>Go</Text>
                </Pressable>
              ) : (
                <>
                  <Pressable onPress={() => send(msg.clipboard(clip))} hitSlop={HIT} style={styles.go}>
                    <Text style={styles.goText}>Set</Text>
                  </Pressable>
                  <Pressable onPress={() => send(msg.clipboard())} hitSlop={HIT} style={[styles.go, styles.goIcon]} accessibilityLabel="Ambil clipboard PC">
                    <MaterialIcons name="refresh" size={16} color={COLORS.text} />
                  </Pressable>
                </>
              )}
            </View>
          </View>
        )}
      </Animated.View>
      </ViewerPanel>
      <ShortcutEditor
        visible={editing != null}
        initial={editing}
        onSave={saveEdit}
        onDelete={editing?.id ? () => deleteShortcut(editing) : null}
        onClose={() => setEditing(null)}
      />
    </SafeAreaView>
    </LayoutAnimationConfig>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  ctl: { flex: 1, overflow: "hidden" },
  tabs: { flexDirection: "row", gap: 3, height: TABS_H, backgroundColor: COLORS.card, borderRadius: 9, padding: 2 },
  tab: { flex: 1, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  tabActive: { backgroundColor: "#5e5ce6" },
  tabText: { color: COLORS.muted, fontWeight: "800", fontSize: 11 },
  tabTextActive: { color: COLORS.text },
  more: { gap: 6 },
  // 5 per row -> every section (max 9-10 buttons) fits in two rows.
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  cell: { width: "18.4%", flexGrow: 1, height: CELL_H, backgroundColor: COLORS.chip, borderRadius: 9, alignItems: "center", justifyContent: "center", gap: 1, paddingHorizontal: 2 },
  cellFn: { width: "15%" },
  cellSmall: { width: "12.5%" },
  cellWide: { width: "48%" },
  cellActive: { backgroundColor: "#5e5ce6", borderWidth: 1, borderColor: COLORS.accent },
  cellPressed: { opacity: 0.6 },
  dangerCell: { backgroundColor: "#7f1d1d" },
  cellText: { color: COLORS.text, fontWeight: "700", textTransform: "capitalize", fontSize: 10 },
  cellTextActive: { color: COLORS.accent },
  scCell: { width: "31.5%", alignItems: "flex-start", paddingHorizontal: 8 },
  scWrap: { width: "31.5%", flexGrow: 1 },
  scFill: { width: "100%" },
  scName: { color: COLORS.text, fontWeight: "800", fontSize: 11 },
  scCombo: { color: COLORS.muted, fontSize: 9 },
  scAdd: { backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.accent, borderStyle: "dashed", alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 4 },
  scAddText: { color: COLORS.accent, fontWeight: "800", fontSize: 11 },
  row: { flexDirection: "row", gap: 6 },
  input: { flex: 1, height: CELL_H, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 0 },
  goIcon: { minWidth: 40 },
  go: { backgroundColor: "#5e5ce6", borderRadius: 10, minWidth: 48, paddingHorizontal: 8, height: CELL_H, alignItems: "center", justifyContent: "center" },
  goAlt: { backgroundColor: COLORS.chip },
  goText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
});
