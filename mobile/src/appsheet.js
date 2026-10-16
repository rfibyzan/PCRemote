/**
 * App launcher sheet, opened from the "+ Aplikasi" tile of the window bar.
 * Lists every Start-menu app on the PC with its real icon:
 *   search (filters as you type), "Terakhir dibuka" (pinned first, then the
 *   apps opened from this phone), then all apps A-Z.
 *   tap        -> open the app on the PC
 *   long press -> Buka / Jalankan sebagai admin / Sematkan (Lepas sematan)
 * Recent + pinned ids are saved on the phone. The list itself is cached on the
 * agent (~10 min); the refresh button rescans.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Image, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import * as SecureStore from "expo-secure-store";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Text from "./AppText";
import Animated, { FadeInDown } from "react-native-reanimated";
import { COLORS } from "./components";
import { MotionModal, MotionPanel, MotionView, PressScale, useLatched } from "./motion";
import { staggerDelay } from "./motionmath";
import { msg } from "./protocol";
import { addListener, getStatus, send } from "./connection";
import { filterApps, pushRecent, quickRow, togglePin } from "./appsmath";
import { registerSetting, settingChanged } from "./settingsync";

const STORE = "pcr_apps";
const ICON = 44;
const CELL = 66;
const OLD_AGENT_MS = 25000;

let cachedList = null; // survives closing the sheet
let prefs = { recent: [], pinned: [] };
let prefsLoaded = false;

const prefListeners = new Set();
function savePrefs() {
  SecureStore.setItemAsync(STORE, JSON.stringify(prefs)).catch(() => {});
  settingChanged("apps", prefs);
}
registerSetting("apps", {
  read: async () => {
    const v = await SecureStore.getItemAsync(STORE);
    return v ? JSON.parse(v) : null;
  },
  apply: (p) => {
    if (!p || !Array.isArray(p.recent) || !Array.isArray(p.pinned)) return;
    prefs = { recent: p.recent, pinned: p.pinned };
    prefsLoaded = true;
    SecureStore.setItemAsync(STORE, JSON.stringify(prefs)).catch(() => {});
    for (const l of [...prefListeners]) l(prefs);
  },
});

function AppIcon({ app, size = ICON }) {
  if (app.icon) {
    return <Image source={{ uri: `data:image/png;base64,${app.icon}` }} style={{ width: size, height: size }} fadeDuration={0} />;
  }
  return (
    <View style={[styles.letter, { width: size, height: size, borderRadius: size / 4 }]}>
      <Text style={styles.letterText}>{(app.name || "?")[0].toUpperCase()}</Text>
    </View>
  );
}

export default function AppSheet({ visible, onClose, onOpened }) {
  const { width } = useWindowDimensions();
  const [list, setList] = useState(cachedList);
  const [state, setState] = useState({
    recent: prefs.recent,
    pinned: prefs.pinned,
  });
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(null);
  const shownMenu = useLatched(menu); // keeps the menu drawn while it fades out
  const [fresh, setFresh] = useState(false); // grid cells fade in only right after opening
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false); // no answer yet after OLD_AGENT_MS
  const [error, setError] = useState("");
  const features = getStatus().hello?.features;
  const oldAgent = !Array.isArray(features) || !features.includes("apps");

  const sheetW = Math.min(width, 560);
  const cols = Math.max(4, Math.floor((sheetW - 24) / CELL));

  useEffect(() => {
    const onPrefs = (p) => setState({ recent: p.recent, pinned: p.pinned });
    prefListeners.add(onPrefs);
    return () => prefListeners.delete(onPrefs);
  }, []);

  useEffect(() => {
    if (prefsLoaded) return;
    SecureStore.getItemAsync(STORE)
      .then((v) => {
        const p = v ? JSON.parse(v) : null;
        if (p && Array.isArray(p.recent) && Array.isArray(p.pinned)) prefs = { recent: p.recent, pinned: p.pinned };
      })
      .catch(() => {})
      .finally(() => {
        prefsLoaded = true;
        setState({ recent: prefs.recent, pinned: prefs.pinned });
      });
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    const off = addListener((e) => {
      if (e.t === "apps" && Array.isArray(e.list)) {
        cachedList = e.list;
        setList(e.list);
        setLoading(false);
        setStale(false);
        setError(typeof e.error === "string" ? e.error : e.error ? "Pemindaian gagal" : "");
      }
      if (e.t === "appOpen" && e.ok === false) {
        Alert.alert("Tidak bisa membuka", "Aplikasi ini tidak ada lagi di PC. Muat ulang daftar.");
      }
    });
    if (!oldAgent) load(false);
    return () => {
      off();
      setQ("");
      setMenu(null);
    };
  }, [visible]);

  // Let grid cells fade in for a moment after the sheet opens or the list
  // arrives; later mounts (scrolling, searching) appear at once.
  const hasList = list != null;
  useEffect(() => {
    if (!visible) return undefined;
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 900);
    return () => clearTimeout(t);
  }, [visible, hasList]);

  useEffect(() => {
    if (!loading) return undefined;
    const t = setTimeout(() => setStale(true), OLD_AGENT_MS);
    return () => clearTimeout(t);
  }, [loading]);

  function load(refresh) {
    setLoading(true);
    setStale(false);
    send(msg.apps(refresh));
  }

  function update(next) {
    prefs = next;
    setState(next);
    savePrefs();
  }

  function open(app, admin = false) {
    setMenu(null);
    send(msg.appOpen(app.id, admin));
    update({ ...prefs, recent: pushRecent(prefs.recent, app.id) });
    onOpened?.(app);
    onClose?.();
  }

  const quick = useMemo(() => quickRow(list, state.recent, state.pinned), [list, state]);
  const found = useMemo(() => filterApps(list, q), [list, q]);
  const searching = q.trim().length > 0;

  const cell = (app, index = 0) => (
    <Animated.View key={app.id} entering={fresh && index < 40 ? FadeInDown.delay(staggerDelay(index, cols)).duration(220) : undefined}>
    <PressScale
      onPress={() => open(app)}
      onLongPress={() => setMenu(app)}
      delayLongPress={350}
      style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
      accessibilityLabel={app.name}
    >
      <AppIcon app={app} />
      {state.pinned.includes(app.id) && <View style={styles.pinDot} />}
      <Text style={styles.cellName} numberOfLines={1}>
        {app.name}
      </Text>
    </PressScale>
    </Animated.View>
  );

  const header = (
    <View>
      {!searching && quick.length > 0 && (
        <>
          <Text style={styles.section}>Terakhir dibuka</Text>
          <View style={styles.quick}>{quick.slice(0, cols).map(cell)}</View>
        </>
      )}
      {!searching && list?.length > 0 && <Text style={styles.section}>Semua aplikasi</Text>}
    </View>
  );

  let body;
  if (list == null) {
    body = (
      <Text style={styles.empty}>
        {oldAgent
          ? "Agent di PC masih versi lama. Perbarui agent (tutup lalu jalankan lagi) untuk daftar aplikasi."
          : stale
            ? "Belum ada balasan dari agent. Coba muat ulang."
            : "Memuat aplikasi… (pertama kali bisa beberapa detik)"}
      </Text>
    );
  } else if (searching) {
    body = (
      <FlatList
        data={found}
        keyExtractor={(a) => a.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={styles.empty}>Tidak ada aplikasi "{q.trim()}".</Text>}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => open(item)}
            onLongPress={() => setMenu(item)}
            delayLongPress={350}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <AppIcon app={item} size={36} />
            <Text style={styles.rowName} numberOfLines={1}>
              {item.name}
            </Text>
            {state.pinned.includes(item.id) && <MaterialCommunityIcons name="pin" size={15} color={COLORS.accent} />}
          </Pressable>
        )}
      />
    );
  } else {
    body = (
      <FlatList
        key={`g${cols}`}
        data={list}
        numColumns={cols}
        keyExtractor={(a) => a.id}
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={styles.empty}>{error ? `Gagal memindai aplikasi: ${error}` : "Tidak ada aplikasi ditemukan."}</Text>}
        renderItem={({ item, index }) => cell(item, index)}
        initialNumToRender={40}
      />
    );
  }

  return (
    <MotionModal visible={visible} dim={0.5} onRequestClose={onClose}>
      <Pressable style={styles.shade} onPress={onClose}>
        <MotionPanel kind="sheet" style={[styles.sheet, { width: sheetW }]}>
        <Pressable style={styles.fill} onPress={() => {}}>
          <View style={styles.grip} />
          <View style={styles.titleRow}>
            <Text style={styles.title}>Aplikasi PC</Text>
            <Pressable onPress={() => load(true)} hitSlop={10} disabled={loading} accessibilityLabel="Muat ulang daftar aplikasi">
              <MaterialCommunityIcons name="refresh" size={21} color={loading ? COLORS.line : COLORS.muted} />
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Tutup">
              <MaterialCommunityIcons name="close" size={21} color={COLORS.muted} />
            </Pressable>
          </View>
          <View style={styles.search}>
            <MaterialCommunityIcons name="magnify" size={18} color={COLORS.muted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Cari aplikasi…"
              placeholderTextColor={COLORS.muted}
              style={styles.input}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="go"
              onSubmitEditing={() => found[0] && open(found[0])}
            />
            {!!q && (
              <Pressable onPress={() => setQ("")} hitSlop={8}>
                <MaterialCommunityIcons name="close-circle" size={16} color={COLORS.muted} />
              </Pressable>
            )}
          </View>
          <View style={styles.body}>{body}</View>

          <MotionView visible={!!menu} kind="fade" style={StyleSheet.absoluteFill}>
            {!!shownMenu && (
            <Pressable style={styles.menuShade} onPress={() => setMenu(null)}>
              <MotionPanel kind="pop">
              <Pressable style={styles.menu} onPress={() => {}}>
                <View style={styles.menuHead}>
                  <AppIcon app={shownMenu} size={40} />
                  <Text style={styles.menuTitle} numberOfLines={2}>
                    {shownMenu.name}
                  </Text>
                </View>
                <Pressable onPress={() => open(shownMenu)} style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}>
                  <MaterialCommunityIcons name="open-in-app" size={19} color={COLORS.text} />
                  <Text style={[styles.itemText, styles.bold]}>Buka</Text>
                </Pressable>
                {shownMenu.admin && (
                  <Pressable onPress={() => open(shownMenu, true)} style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}>
                    <MaterialCommunityIcons name="shield-account-outline" size={19} color={COLORS.text} />
                    <View>
                      <Text style={styles.itemText}>Jalankan sebagai admin</Text>
                      <Text style={styles.itemSub}>Konfirmasi UAC di PC</Text>
                    </View>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => {
                    update({
                      ...prefs,
                      pinned: togglePin(prefs.pinned, shownMenu.id),
                    });
                    setMenu(null);
                  }}
                  style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                >
                  <MaterialCommunityIcons name={state.pinned.includes(shownMenu.id) ? "pin-off-outline" : "pin-outline"} size={19} color={COLORS.text} />
                  <Text style={styles.itemText}>{state.pinned.includes(shownMenu.id) ? "Lepas sematan" : "Sematkan ke Terakhir"}</Text>
                </Pressable>
              </Pressable>
              </MotionPanel>
            </Pressable>
          )}
          </MotionView>
        </Pressable>
        </MotionPanel>
      </Pressable>
    </MotionModal>
  );
}

const styles = StyleSheet.create({
  shade: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  fill: { flex: 1 },
  sheet: {
    height: "82%",
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 12,
    overflow: "hidden",
  },
  grip: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.line,
    marginTop: 8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 10,
  },
  title: { flex: 1, color: COLORS.text, fontSize: 17, fontWeight: "700" },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.chip,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
  },
  input: { flex: 1, color: COLORS.text, fontSize: 14, paddingVertical: 0 },
  body: { flex: 1, paddingTop: 6 },
  section: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 6,
  },
  quick: { flexDirection: "row" },
  cell: { width: CELL, alignItems: "center", paddingVertical: 6 },
  cellName: {
    color: COLORS.text,
    fontSize: 10,
    marginTop: 4,
    width: CELL - 6,
    textAlign: "center",
  },
  pinDot: {
    position: "absolute",
    top: 4,
    right: 9,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.accent,
  },
  pressed: { opacity: 0.55 },
  letter: {
    backgroundColor: COLORS.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  letterText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  rowName: { flex: 1, color: COLORS.text, fontSize: 14, fontWeight: "600" },
  empty: {
    color: COLORS.muted,
    fontSize: 13,
    textAlign: "center",
    marginTop: 30,
    paddingHorizontal: 20,
  },
  menuShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    padding: 30,
  },
  menu: {
    backgroundColor: "#242428",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    overflow: "hidden",
    paddingBottom: 6,
  },
  menuHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  menuTitle: { flex: 1, color: COLORS.text, fontSize: 15, fontWeight: "700" },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  itemPressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  itemText: { color: COLORS.text, fontSize: 14 },
  itemSub: { color: COLORS.muted, fontSize: 11, marginTop: 1 },
  bold: { fontWeight: "700" },
});
