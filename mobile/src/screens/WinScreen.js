/** WIN: PC screen viewer + monitor/source + stream controls + Windows controls. */
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
const FKEYS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
const MODS = ["ctrl", "alt", "shift", "win"];
// Bigger touch target without bigger visuals (Win buttons are Type-small).
// Horizontal slop stays <= gap (3px) so adjacent buttons never overlap and
// RN can't pick the wrong one; vertical gets a bit more (rows are taller).
const HIT = { top: 4, bottom: 4, left: 2, right: 2 };

export default function WinScreen() {
  const [clip, setClip] = useState("");
  const [url, setUrl] = useState("");
  const [more, setMore] = useState(false);
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

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Win</Text>
        <ConnDot />
      </View>
      <ViewerPanel viewerHeight={null} touchpad={false} actions={false} onTap={releaseApps} />
      <ScrollView style={styles.ctl} contentContainerStyle={styles.ctlContent}>
      <View style={styles.grid}>
        <Pressable onPress={() => send(msg.key("win"))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Start</Text></Pressable>
        <Pressable onPress={tapApps} hitSlop={HIT} style={[styles.cell, appsHeld && styles.cellActive]}>
          <Text style={[styles.cellText, appsHeld && styles.cellTextActive]}>Apps</Text>
        </Pressable>
        <Pressable onPress={() => send(msg.combo(["alt", "f4"]))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Close</Text></Pressable>
        <Pressable onPress={() => send(msg.key("esc"))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Esc</Text></Pressable>
        <Pressable onPress={() => send(msg.combo(["win", "tab"]))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Task View</Text></Pressable>
        <Pressable onPress={() => send(msg.combo(["win", "d"]))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Desktop</Text></Pressable>
        <Pressable onPress={() => send(msg.open("explorer"))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Files</Text></Pressable>
        <Pressable onPress={() => send(msg.open("browser"))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Browser</Text></Pressable>
        <Pressable onPress={() => send(msg.combo(["ctrl", "c"]))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Copy</Text></Pressable>
        <Pressable onPress={() => send(msg.combo(["ctrl", "v"]))} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>Paste</Text></Pressable>
        <Pressable onPress={() => send(msg.clipboard())} hitSlop={HIT} style={styles.cell}><Text style={styles.cellText}>PC Clip</Text></Pressable>
        {MODS.map((k) => (
          <Pressable key={k} onPress={() => send(msg.key(k))} hitSlop={HIT} style={styles.cell}>
            <Text style={styles.cellText}>{k}</Text>
          </Pressable>
        ))}
        {MEDIA.map((m) => (
          <Pressable key={m.a} onPress={() => send(msg.media(m.a))} hitSlop={HIT} style={styles.cell} accessibilityLabel={m.a}>
            <MaterialIcons name={m.icon} size={16} color={COLORS.text} />
          </Pressable>
        ))}
        <Pressable onPress={() => send(msg.lock())} hitSlop={HIT} style={[styles.cell, styles.dangerCell]} accessibilityLabel="Lock PC">
          <MaterialIcons name="lock" size={16} color={COLORS.text} />
        </Pressable>
      </View>
      <View style={styles.fRow}>
        {FKEYS.map((k) => (
          <Pressable key={k} onPress={() => send(msg.key(k))} hitSlop={HIT} style={styles.fCell}>
            <Text style={styles.fText}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => setMore((m) => !m)} hitSlop={HIT} style={styles.cell}>
        <Text style={styles.cellText}>More {more ? "▾" : "▸"}</Text>
      </Pressable>
      {more && (
      <View style={styles.more}>
      <Text style={styles.section}>Launch</Text>
      <View style={styles.grid}>
        {APPS.map((a) => (
          <Pressable key={a} onPress={() => send(msg.open(a))} hitSlop={HIT} style={styles.cell}>
            <Text style={styles.cellText}>{a}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.section}>Open URL</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="https://…" placeholderTextColor={COLORS.muted} autoCapitalize="none" />
        <Pressable onPress={() => url.trim() && send(msg.open(url.trim()))} hitSlop={HIT} style={styles.go}>
          <Text style={styles.cellText}>Go</Text>
        </Pressable>
      </View>
      <Text style={styles.section}>Clipboard</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={clip} onChangeText={setClip} placeholder="(empty)" placeholderTextColor={COLORS.muted} multiline />
        <Pressable onPress={() => send(msg.clipboard(clip))} hitSlop={HIT} style={styles.go}>
          <Text style={styles.cellText}>Set</Text>
        </Pressable>
      </View>
      <Pressable onPress={() => send(msg.clipboard())} hitSlop={HIT} style={styles.cell}>
        <Text style={styles.cellText}>Refresh clipboard</Text>
      </Pressable>
      </View>
      )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  ctl: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  ctlContent: { padding: 8, paddingTop: 4, gap: 4, paddingBottom: 12 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 },
  title: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  section: { color: COLORS.muted, fontWeight: "800", marginTop: 0, fontSize: 11 },
  more: { gap: 5 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 3 },
  fRow: { flexDirection: "row", gap: 3 },
  fCell: { flex: 1, backgroundColor: COLORS.chip, borderRadius: 8, paddingVertical: 7, alignItems: "center", minWidth: 0 },
  fText: { color: COLORS.text, fontWeight: "700", fontSize: 11, textTransform: "uppercase" },
  cell: { flexGrow: 1, width: "23%", minWidth: 0, backgroundColor: COLORS.chip, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  cellActive: { backgroundColor: "#0c4a6e" },
  dangerCell: { backgroundColor: "#7f1d1d" },
  cellText: { color: COLORS.text, fontWeight: "700", textTransform: "capitalize", fontSize: 11 },
  cellTextActive: { color: COLORS.accent },
  row: { flexDirection: "row", gap: 6 },
  input: { flex: 1, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, padding: 10 },
  go: { backgroundColor: "#0c4a6e", borderRadius: 8, padding: 10, justifyContent: "center" },
});
