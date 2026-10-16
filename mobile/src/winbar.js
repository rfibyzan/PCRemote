/**
 * Window bar (Sill-style switcher), replaces the old Alt+Tab "Apps" hold.
 * A strip of open windows with live thumbnails over the bottom of the stream.
 *   tap        -> bring that window to the front on the PC
 *   long press -> menu: Stream jendela ini / Minimize / Maksimalkan / Tutup
 * While open it asks the agent for {t:"windows", thumbs:1} every 2 s; the
 * agent answers with the list and then {t:"winThumbs", thumbs:{id: base64}}.
 * Minimized windows (and old agents) have no thumbnail: an icon shows instead.
 * Wrap the bar in Block where it sits over the viewer.
 */
import React, { useEffect, useState } from "react";
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Text from "./AppText";
import { COLORS } from "./components";
import { msg } from "./protocol";
import { addListener, send } from "./connection";
import { pruneThumbs, tileName } from "./winbarmath";

const POLL_MS = 2000;
const TW = 104;
const TH = 62;

export default function WindowThumbBar({ activeId = null, onFocus, onStream }) {
  const [list, setList] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const [menu, setMenu] = useState(null);

  useEffect(() => {
    const off = addListener((e) => {
      if (e.t === "windows" && Array.isArray(e.list)) {
        setList(e.list);
        setThumbs((t) => pruneThumbs(t, e.list));
      }
      if (e.t === "winThumbs" && e.thumbs && typeof e.thumbs === "object") {
        setThumbs((t) => ({ ...t, ...e.thumbs }));
      }
    });
    send(msg.windows(true));
    const timer = setInterval(() => send(msg.windows(true)), POLL_MS);
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  function act(w, a) {
    setMenu(null);
    if (a === "stream") {
      onStream?.(w);
      return;
    }
    if (a === "close") {
      Alert.alert("Tutup jendela?", `${tileName(w)}: ${w.title}`, [
        { text: "Batal", style: "cancel" },
        { text: "Tutup", style: "destructive", onPress: () => send(msg.winAct(w.id, "close")) },
      ]);
      return;
    }
    send(msg.winAct(w.id, a));
    setTimeout(() => send(msg.windows(true)), 400);
  }

  return (
    <View style={styles.strip}>
      {list == null && <Text style={styles.empty}>Memuat jendela…</Text>}
      {list != null && !list.length && <Text style={styles.empty}>Tidak ada jendela terbuka.</Text>}
      {!!list?.length && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {list.map((w) => {
            const img = thumbs[w.id];
            const on = activeId != null && String(activeId) === String(w.id);
            return (
              <Pressable
                key={w.id}
                onPress={() => {
                  onFocus?.(w);
                  setTimeout(() => send(msg.windows(true)), 400);
                }}
                onLongPress={() => setMenu(w)}
                delayLongPress={350}
                style={({ pressed }) => [styles.tile, on && styles.tileOn, pressed && styles.pressed]}
                accessibilityLabel={`${tileName(w)}: ${w.title}`}
              >
                <View style={styles.thumb}>
                  {img ? (
                    <Image source={{ uri: `data:image/jpeg;base64,${img}` }} style={styles.thumbImg} resizeMode="cover" fadeDuration={0} />
                  ) : (
                    <MaterialCommunityIcons name={w.min ? "window-minimize" : "application-outline"} size={24} color={COLORS.muted} />
                  )}
                </View>
                <Text style={styles.name} numberOfLines={1}>
                  {tileName(w)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      <Modal visible={!!menu} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={styles.shade} onPress={() => setMenu(null)}>
          {!!menu && (
            <Pressable style={styles.sheet} onPress={() => {}}>
              <View style={styles.head}>
                <View style={[styles.thumb, styles.headThumb]}>
                  {thumbs[menu.id] ? (
                    <Image source={{ uri: `data:image/jpeg;base64,${thumbs[menu.id]}` }} style={styles.thumbImg} resizeMode="cover" />
                  ) : (
                    <MaterialCommunityIcons name="application-outline" size={26} color={COLORS.muted} />
                  )}
                </View>
                <View style={styles.headText}>
                  <Text style={styles.headTitle} numberOfLines={1}>
                    {tileName(menu)}
                  </Text>
                  <Text style={styles.headSub} numberOfLines={2}>
                    {menu.title}
                  </Text>
                </View>
              </View>
              {[
                ["stream", "Stream jendela ini", "fit-to-screen-outline"],
                ["min", "Minimize", "window-minimize"],
                ["max", "Maksimalkan", "window-maximize"],
                ["close", "Tutup", "window-close"],
              ].map(([a, label, icon]) => (
                <Pressable key={a} onPress={() => act(menu, a)} style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}>
                  <MaterialCommunityIcons name={icon} size={19} color={a === "close" ? "#ff6b6b" : COLORS.text} />
                  <Text style={[styles.itemText, a === "close" && styles.itemDanger]}>{label}</Text>
                </Pressable>
              ))}
            </Pressable>
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { backgroundColor: "rgba(18,18,20,0.92)", borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, paddingVertical: 6, minHeight: 48, justifyContent: "center" },
  row: { paddingHorizontal: 6, gap: 6 },
  empty: { color: COLORS.muted, fontSize: 12, textAlign: "center" },
  tile: { width: TW, borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, backgroundColor: "#242428", padding: 3 },
  tileOn: { borderColor: COLORS.accent, borderWidth: 2 },
  pressed: { opacity: 0.6 },
  thumb: { height: TH, borderRadius: 5, backgroundColor: "#1a1a1d", overflow: "hidden", alignItems: "center", justifyContent: "center" },
  thumbImg: { width: "100%", height: "100%" },
  name: { color: COLORS.text, fontSize: 11, fontWeight: "600", marginTop: 3, paddingHorizontal: 2 },
  shade: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 28 },
  sheet: { backgroundColor: "#1c1c1f", borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, overflow: "hidden", paddingBottom: 6 },
  head: { flexDirection: "row", gap: 12, padding: 14, alignItems: "center", borderBottomWidth: 1, borderBottomColor: COLORS.line },
  headThumb: { width: TW, height: TH },
  headText: { flex: 1 },
  headTitle: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
  headSub: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  itemPressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  itemText: { color: COLORS.text, fontSize: 14, fontWeight: "500" },
  itemDanger: { color: "#ff6b6b" },
});
