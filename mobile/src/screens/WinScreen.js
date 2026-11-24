/** WIN (layout C, v2): shared viewer + fixed control area: section tabs
 * (Sering | Sistem | Edit | Media | Fn | Pintasan | Lainnya) over two rows of
 * icon + label cards. "Sering" fills itself with the buttons used most on
 * this phone (defaults until there is history). Lock needs a long press.
 * The area itself never grows, so the viewer stays the same size. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Text from "../AppText";
import { MaterialIcons } from "@expo/vector-icons";
import { COLORS } from "../components";
import { useViewerSlot } from "../viewerslot";
import { rowHeight } from "../tablayout";
import { msg } from "../protocol";
import { addListener, send } from "../connection";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import ShortcutEditor from "../shortcuteditor";
import { setClipSync, useClipSync } from "../clipsync";
import { MotionModal, MotionPanel, PressScale, SlideTabs, popIn, useLatched } from "../motion";
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
  { a: "pause", icon: "play-arrow", label: "Play/Pause" },
  { a: "stop", icon: "stop", label: "Stop" },
  { a: "prev", icon: "skip-previous", label: "Prev" },
  { a: "next", icon: "skip-next", label: "Next" },
  { a: "mute", icon: "volume-off", label: "Mute" },
  { a: "voldown", icon: "volume-down", label: "Vol −" },
  { a: "volup", icon: "volume-up", label: "Vol +" },
];
const FKEYS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"];
const SECTIONS = ["Sering", "Sistem", "Edit", "Media", "Fn", "Pintasan", "Lainnya"];
const SISTEM = ["start", "apps", "taskview", "desktop", "close", "esc", "files", "browser", "lock"];
const EDIT = ["copy", "paste", "cut", "selectall", "undo", "redo", "save", "find"];
const SERING_N = 8;
const SERING_DEFAULT = ["start", "taskview", "desktop", "files", "browser", "copy", "paste", "lock"];
// Last section survives tab switches (WIN stays mounted, but keep it explicit).
let lastSection = "Sering";
const TABS_H = 32;
const CELL_H = rowHeight(2, [TABS_H]);
const INPUT_H = 44;

// Usage counts for "Sering" (per phone, survives restarts).
const STORE_USE = "pcremote.winuse";
const use = { counts: {}, timer: null };
SecureStore.getItemAsync(STORE_USE)
  .then((raw) => {
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") use.counts = { ...v, ...use.counts };
  })
  .catch(() => {});
function countUse(id) {
  use.counts[id] = (use.counts[id] || 0) + 1;
  if (use.timer) clearTimeout(use.timer);
  use.timer = setTimeout(() => {
    use.timer = null;
    SecureStore.setItemAsync(STORE_USE, JSON.stringify(use.counts)).catch(() => {});
  }, 1500);
}
/** Most used first; the defaults fill the rest (never more than n). */
export function seringIds(counts, known, n = SERING_N, defaults = SERING_DEFAULT) {
  const used = Object.keys(counts || {})
    .filter((id) => known.includes(id) && counts[id] > 0)
    .sort((a, b) => counts[b] - counts[a] || known.indexOf(a) - known.indexOf(b));
  const out = used.slice(0, n);
  for (const id of defaults) if (out.length < n && !out.includes(id)) out.push(id);
  return out;
}
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
  const clipAuto = useClipSync().on;
  const [editing, setEditing] = useState(null); // null | {} (new) | shortcut
  // Lock is a long press; a plain tap just says so for a moment.
  const [lockHint, setLockHint] = useState(false);
  const lockTimer = useRef(null);
  useEffect(() => () => lockTimer.current && clearTimeout(lockTimer.current), []);
  function tapLock() {
    setLockHint(true);
    if (lockTimer.current) clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => setLockHint(false), 1600);
  }

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
  // Long-press menu of a shortcut tile: one aligned row per action (the
  // native Android alert only lays out 3 buttons, so 5 looked scattered).
  const [scMenu, setScMenu] = useState(null);
  const [scMenuFrom, setScMenuFrom] = useState(null); // grows out of the held tile
  const scShown = useLatched(scMenu);
  function shortcutMenu(sc, e) {
    setScMenuFrom(e?.nativeEvent ? { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY } : null);
    setScMenu(sc);
  }
  function scAction(a) {
    const sc = scMenu;
    setScMenu(null);
    if (!sc) return;
    if (a === "edit") setEditing(sc);
    else if (a === "left") saveShortcuts(moveShortcut(shortcuts, sc.id, -1));
    else if (a === "right") saveShortcuts(moveShortcut(shortcuts, sc.id, 1));
    else if (a === "delete") deleteShortcut(sc);
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

  function Btn({ label, icon, onPress, onLongPress, active, danger, wide, fn, small, four, a11y, sub }) {
    return (
      <PressScale
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={450}
        hitSlop={HIT}
        accessibilityLabel={a11y || label}
        style={({ pressed }) => [styles.cell, fn && styles.cellFn, small && styles.cellSmall, four && styles.cellFour, wide && styles.cellWide, active && styles.cellActive, danger && styles.dangerCell, pressed && styles.cellPressed]}
      >
        {icon ? <MaterialIcons name={icon} size={small ? 18 : 20} color={danger ? "#ff6b6b" : active ? "#ffffff" : COLORS.text} /> : null}
        {label ? <Text style={[styles.cellText, active && styles.cellTextActive, danger && styles.dangerText]} numberOfLines={1}>{label}</Text> : null}
        {sub ? <Text style={styles.cellSub} numberOfLines={1}>{sub}</Text> : null}
      </PressScale>
    );
  }

  // Every button that can show up in "Sering", by id.
  const ACT = {
    start: { icon: "apps", label: "Start", run: () => send(msg.key("win")) },
    apps: { icon: "swap-horiz", label: "Apps", run: tapApps, active: appsHeld },
    taskview: { icon: "view-carousel", label: "Task View", run: () => send(msg.combo(["win", "tab"])) },
    desktop: { icon: "desktop-windows", label: "Desktop", run: () => send(msg.combo(["win", "d"])) },
    close: { icon: "close", label: "Close", run: () => send(msg.combo(["alt", "f4"])) },
    esc: { icon: "keyboard-return", label: "Esc", run: () => send(msg.key("esc")) },
    files: { icon: "folder", label: "Files", run: () => send(msg.open("explorer")) },
    browser: { icon: "public", label: "Browser", run: () => send(msg.open("browser")) },
    lock: { icon: "lock", label: lockHint ? "Tahan…" : "Kunci", sub: "tahan", danger: true, a11y: "Kunci PC (tahan)", run: tapLock, long: () => send(msg.lock()) },
    copy: { icon: "content-copy", label: "Copy", run: () => send(msg.combo(["ctrl", "c"])) },
    paste: { icon: "content-paste", label: "Paste", run: () => send(msg.combo(["ctrl", "v"])) },
    cut: { icon: "content-cut", label: "Cut", run: () => send(msg.combo(["ctrl", "x"])) },
    selectall: { icon: "select-all", label: "Select all", run: () => send(msg.combo(["ctrl", "a"])) },
    undo: { icon: "undo", label: "Undo", run: () => send(msg.combo(["ctrl", "z"])) },
    redo: { icon: "redo", label: "Redo", run: () => send(msg.combo(["ctrl", "y"])) },
    save: { icon: "save", label: "Save", run: () => send(msg.combo(["ctrl", "s"])) },
    find: { icon: "search", label: "Find", run: () => send(msg.combo(["ctrl", "f"])) },
  };
  for (const m of MEDIA) ACT["media_" + m.a] = { icon: m.icon, label: m.label, a11y: m.a, run: () => send(msg.media(m.a)) };
  const KNOWN = Object.keys(ACT);
  // Ranked when the section opens, so buttons never jump under the finger.
  const sering = useMemo(() => seringIds(use.counts, KNOWN), [section]); // eslint-disable-line react-hooks/exhaustive-deps

  function renderAct(id, four) {
    const a = ACT[id];
    if (!a) return null;
    return (
      <Btn
        key={id}
        icon={a.icon}
        label={a.label}
        sub={a.sub}
        a11y={a.a11y}
        active={a.active}
        danger={a.danger}
        four={four}
        onPress={() => {
          if (!a.long) countUse(id);
          a.run();
        }}
        onLongPress={
          a.long
            ? () => {
                countUse(id);
                setLockHint(false);
                a.long();
              }
            : undefined
        }
      />
    );
  }

  const controls = (
    <LayoutAnimationConfig skipEntering>
      <SlideTabs
        items={SECTIONS}
        value={section}
        onChange={setSection}
        style={styles.tabs}
        tabStyle={(sec) => [styles.tab, (sec === "Sering" || sec === "Pintasan" || sec === "Lainnya") && styles.tabWide]}
        activeColor={styles.tabActive.backgroundColor}
        renderLabel={(sec, on) => (
          <Text style={[styles.tabText, on && styles.tabTextActive]} numberOfLines={1}>
            {sec === "Sering" ? "★ Sering" : sec}
          </Text>
        )}
      />
      <Animated.View key={section} entering={FadeIn.duration(150)} style={styles.ctl}>
        {section === "Sering" && <View style={styles.grid}>{sering.map((id) => renderAct(id, true))}</View>}
        {section === "Sistem" && <View style={styles.grid}>{SISTEM.map((id) => renderAct(id, false))}</View>}
        {section === "Edit" && <View style={styles.grid}>{EDIT.map((id) => renderAct(id, true))}</View>}
        {section === "Media" && <View style={styles.grid}>{MEDIA.map((m) => renderAct("media_" + m.a, true))}</View>}
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
                onLongPress={(e) => shortcutMenu(sc, e)}
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
            <View style={[styles.row, { height: INPUT_H }]}>
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
                  {/* Auto = clipboard follows both ways (clipsync.js). */}
                  <Pressable
                    onPress={() => setClipSync(!clipAuto)}
                    hitSlop={HIT}
                    style={[styles.go, clipAuto ? styles.goOn : styles.goAlt]}
                    accessibilityLabel={clipAuto ? "Matikan sinkron clipboard otomatis" : "Nyalakan sinkron clipboard otomatis"}
                  >
                    <MaterialIcons name={clipAuto ? "sync" : "sync-disabled"} size={16} color={COLORS.text} />
                    <Text style={styles.goSmall}>Auto</Text>
                  </Pressable>
                  <Pressable onPress={() => send(msg.clipboard(clip))} hitSlop={HIT} style={styles.go}>
                    <Text style={styles.goText}>Set</Text>
                  </Pressable>
                  {!clipAuto && (
                    <Pressable onPress={() => send(msg.clipboard())} hitSlop={HIT} style={[styles.go, styles.goIcon]} accessibilityLabel="Ambil clipboard PC">
                      <MaterialIcons name="refresh" size={16} color={COLORS.text} />
                    </Pressable>
                  )}
                </>
              )}
            </View>
          </View>
        )}
      </Animated.View>
    </LayoutAnimationConfig>
  );
  useViewerSlot("Win", { title: "Win", onTap: releaseApps, controls });
  // The shortcut editor is a Modal, so it shows from this (empty) tab scene.
  return (
    <>
      <ShortcutEditor
        visible={editing != null}
        initial={editing}
        onSave={saveEdit}
        onDelete={editing?.id ? () => deleteShortcut(editing) : null}
        onClose={() => setEditing(null)}
      />
      <MotionModal visible={!!scMenu} onRequestClose={() => setScMenu(null)}>
        <Pressable style={styles.menuShade} onPress={() => setScMenu(null)}>
          {!!scShown && (
            <MotionPanel from={scMenuFrom}>
              <Pressable style={styles.menuSheet} onPress={() => {}}>
                <View style={styles.menuHead}>
                  <View style={styles.menuIcon}>
                    <MaterialIcons name="keyboard" size={20} color={COLORS.accent} />
                  </View>
                  <View style={styles.menuHeadText}>
                    <Text style={styles.menuTitle} numberOfLines={1}>{scShown.name}</Text>
                    <Text style={styles.menuSub} numberOfLines={1}>{comboLabel(scShown)}</Text>
                  </View>
                </View>
                {(() => {
                  const i = shortcuts.findIndex((x) => x.id === scShown.id);
                  return [
                    ["edit", "Edit", "edit", false],
                    ["left", "Geser kiri", "arrow-back", i <= 0],
                    ["right", "Geser kanan", "arrow-forward", i < 0 || i >= shortcuts.length - 1],
                    ["delete", "Hapus", "delete-outline", false],
                  ].map(([a, label, icon, off]) => (
                    <Pressable
                      key={a}
                      disabled={off}
                      onPress={() => scAction(a)}
                      style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed, off && styles.menuItemOff]}
                    >
                      <MaterialIcons name={icon} size={20} color={a === "delete" ? "#ff6b6b" : COLORS.text} />
                      <Text style={[styles.menuText, a === "delete" && styles.menuDanger]}>{label}</Text>
                    </Pressable>
                  ));
                })()}
                <View style={styles.menuSep} />
                <Pressable onPress={() => setScMenu(null)} style={({ pressed }) => [styles.menuItem, styles.menuCancel, pressed && styles.menuItemPressed]}>
                  <Text style={styles.menuCancelText}>Batal</Text>
                </Pressable>
              </Pressable>
            </MotionPanel>
          )}
        </Pressable>
      </MotionModal>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  ctl: { flex: 1, overflow: "hidden" },
  tabs: { flexDirection: "row", gap: 2, height: TABS_H, backgroundColor: COLORS.card, borderRadius: 10, padding: 2 },
  tab: { flex: 1, minWidth: 0, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  tabWide: { flex: 1.45 },
  tabActive: { backgroundColor: "#5e5ce6" },
  tabText: { color: COLORS.muted, fontWeight: "700", fontSize: 11 },
  tabTextActive: { color: COLORS.text },
  more: { gap: 6 },
  // 5 per row -> every section (max 9-10 buttons) fits in two rows.
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  cell: { width: "18.4%", flexGrow: 1, height: CELL_H, backgroundColor: COLORS.card, borderWidth: StyleSheet.hairlineWidth, borderColor: "#3a3a3e", borderRadius: 12, alignItems: "center", justifyContent: "center", gap: 3, paddingHorizontal: 2 },
  cellFn: { width: "15%" },
  cellFour: { width: "23%" },
  cellSmall: { width: "12.5%" },
  cellWide: { width: "48%" },
  cellActive: { backgroundColor: "#5e5ce6", borderWidth: 1, borderColor: COLORS.accent },
  cellPressed: { opacity: 0.6 },
  dangerCell: { backgroundColor: "#3a1517", borderColor: "#7f1d1d" },
  dangerText: { color: "#ff9b9b" },
  cellText: { color: COLORS.text, fontWeight: "600", fontSize: 11 },
  cellSub: { color: "rgba(255,155,155,0.6)", fontSize: 9, fontWeight: "500" },
  cellTextActive: { color: COLORS.accent },
  scCell: { width: "31.5%", alignItems: "flex-start", paddingHorizontal: 8 },
  scWrap: { width: "31.5%", flexGrow: 1 },
  scFill: { width: "100%" },
  scName: { color: COLORS.text, fontWeight: "800", fontSize: 11 },
  scCombo: { color: COLORS.muted, fontSize: 9 },
  scAdd: { backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.accent, borderStyle: "dashed", alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 4 },
  scAddText: { color: COLORS.accent, fontWeight: "800", fontSize: 11 },
  row: { flexDirection: "row", gap: 6 },
  input: { flex: 1, height: INPUT_H, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 0 },
  goIcon: { minWidth: 40 },
  go: { backgroundColor: "#5e5ce6", borderRadius: 10, minWidth: 48, paddingHorizontal: 8, height: INPUT_H, alignItems: "center", justifyContent: "center" },
  goAlt: { backgroundColor: COLORS.chip },
  // Shortcut long-press menu (same look as the Jendela menu in winbar.js).
  menuShade: { flex: 1, justifyContent: "center", padding: 28 },
  menuSheet: { backgroundColor: "#1c1c1f", borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, overflow: "hidden", paddingBottom: 4 },
  menuHead: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  menuIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: "rgba(94,92,230,0.18)", alignItems: "center", justifyContent: "center" },
  menuHeadText: { flex: 1, minWidth: 0 },
  menuTitle: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
  menuSub: { color: COLORS.accent, fontSize: 12, fontWeight: "600", marginTop: 2 },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 18, height: 48 },
  menuItemPressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  menuItemOff: { opacity: 0.35 },
  menuText: { color: COLORS.text, fontSize: 14, fontWeight: "500" },
  menuDanger: { color: "#ff6b6b" },
  menuSep: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.line, marginTop: 4 },
  menuCancel: { justifyContent: "center" },
  menuCancelText: { color: COLORS.muted, fontSize: 14, fontWeight: "600" },
  goOn: { backgroundColor: "rgba(94,92,230,0.35)", borderWidth: 1, borderColor: COLORS.accent },
  goSmall: { color: COLORS.text, fontWeight: "700", fontSize: 9 },
  goText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
});
