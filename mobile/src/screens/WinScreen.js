/** WIN: shared fixed-size viewer + Windows controls in sections
 * (Sistem | Edit | Media | Fn | Lainnya) so the panel never scrolls far. */
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { COLORS } from "../components";
import { ConnDot } from "../controls";
import ViewerPanel from "../viewer";
import { msg } from "../protocol";
import { addListener, send } from "../connection";

const APPS = ["explorer", "taskmgr", "notepad", "terminal", "browser", "settings", "calc"];
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
const SECTIONS = ["Sistem", "Edit", "Media", "Fn", "Lainnya"];
// Last section survives tab switches (WIN stays mounted, but keep it explicit).
let lastSection = "Sistem";
const MODS = ["ctrl", "alt", "shift", "win"];
// Bigger touch target without bigger visuals (Win buttons are Type-small).
// Horizontal slop stays <= gap (3px) so adjacent buttons never overlap and
// RN can't pick the wrong one; vertical gets a bit more (rows are taller).
const HIT = { top: 4, bottom: 4, left: 2, right: 2 };

export default function WinScreen() {
  const [clip, setClip] = useState("");
  const [url, setUrl] = useState("");
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

  function Btn({ label, icon, onPress, active, danger, wide, a11y }) {
    return (
      <Pressable
        onPress={onPress}
        hitSlop={HIT}
        accessibilityLabel={a11y || label}
        style={({ pressed }) => [styles.cell, wide && styles.cellWide, active && styles.cellActive, danger && styles.dangerCell, pressed && styles.cellPressed]}
      >
        {icon ? <MaterialIcons name={icon} size={18} color={COLORS.text} /> : null}
        {label ? <Text style={[styles.cellText, active && styles.cellTextActive]} numberOfLines={1}>{label}</Text> : null}
      </Pressable>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Win</Text>
        <ConnDot />
      </View>
      <ViewerPanel touchpad={false} actions={false} onTap={releaseApps} />
      <View style={styles.tabs}>
        {SECTIONS.map((sec) => (
          <Pressable key={sec} onPress={() => setSection(sec)} style={[styles.tab, section === sec && styles.tabActive]}>
            <Text style={[styles.tabText, section === sec && styles.tabTextActive]}>{sec}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView style={styles.ctl} contentContainerStyle={styles.ctlContent} keyboardShouldPersistTaps="handled">
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
            {MODS.map((k) => (
              <Btn key={k} label={k[0].toUpperCase() + k.slice(1)} onPress={() => send(msg.key(k))} />
            ))}
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
              <Btn key={k} label={k.toUpperCase()} onPress={() => send(msg.key(k))} />
            ))}
          </View>
        )}
        {section === "Lainnya" && (
          <View style={styles.more}>
            <Text style={styles.section}>Buka aplikasi</Text>
            <View style={styles.grid}>
              {APPS.map((a) => (
                <Btn key={a} label={a} onPress={() => send(msg.open(a))} />
              ))}
            </View>
            <Text style={styles.section}>Buka URL</Text>
            <View style={styles.row}>
              <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="https://…" placeholderTextColor={COLORS.muted} autoCapitalize="none" />
              <Pressable onPress={() => url.trim() && send(msg.open(url.trim()))} hitSlop={HIT} style={styles.go}>
                <Text style={styles.goText}>Go</Text>
              </Pressable>
            </View>
            <Text style={styles.section}>Clipboard PC</Text>
            <View style={styles.row}>
              <TextInput style={styles.input} value={clip} onChangeText={setClip} placeholder="(kosong)" placeholderTextColor={COLORS.muted} multiline />
              <View style={styles.clipBtns}>
                <Pressable onPress={() => send(msg.clipboard(clip))} hitSlop={HIT} style={styles.go}>
                  <Text style={styles.goText}>Set</Text>
                </Pressable>
                <Pressable onPress={() => send(msg.clipboard())} hitSlop={HIT} style={[styles.go, styles.goAlt]}>
                  <MaterialIcons name="refresh" size={16} color={COLORS.text} />
                </Pressable>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  ctl: { flex: 1 },
  ctlContent: { paddingHorizontal: 8, paddingBottom: 12, gap: 6 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, height: 32 },
  title: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  tabs: { flexDirection: "row", gap: 4, marginHorizontal: 8, marginBottom: 6, backgroundColor: COLORS.card, borderRadius: 10, padding: 3 },
  tab: { flex: 1, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  tabActive: { backgroundColor: "#0c4a6e" },
  tabText: { color: COLORS.muted, fontWeight: "800", fontSize: 11 },
  tabTextActive: { color: COLORS.text },
  section: { color: COLORS.muted, fontWeight: "800", fontSize: 11, marginTop: 2 },
  more: { gap: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  cell: { width: "23.5%", flexGrow: 1, height: 48, backgroundColor: COLORS.chip, borderRadius: 10, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: 4 },
  cellWide: { width: "48%" },
  cellActive: { backgroundColor: "#0c4a6e", borderWidth: 1, borderColor: COLORS.accent },
  cellPressed: { opacity: 0.6 },
  dangerCell: { backgroundColor: "#7f1d1d", flexGrow: 0 },
  cellText: { color: COLORS.text, fontWeight: "700", textTransform: "capitalize", fontSize: 11 },
  cellTextActive: { color: COLORS.accent },
  row: { flexDirection: "row", gap: 6 },
  input: { flex: 1, minHeight: 44, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  clipBtns: { gap: 6 },
  go: { backgroundColor: "#0c4a6e", borderRadius: 10, minWidth: 48, height: 44, alignItems: "center", justifyContent: "center" },
  goAlt: { backgroundColor: COLORS.chip },
  goText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
});
