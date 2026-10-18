/** "Versi baru tersedia" banner, drawn once at the top of every screen
 * (root layout). Checks GitHub's latest release at start and when the app
 * comes back after 6 h, and reads the PC agent's hello.version. "Unduh"
 * opens the APK link (the browser downloads it, Android installs it);
 * "Nanti" hides that version until a newer one appears. Release builds only.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, StyleSheet, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import Text from "./AppText";
import { COLORS } from "./components";
import { PressScale } from "./motion";
import { addListener, getStatus } from "./connection";
import { CHECK_EVERY_MS, RELEASES_API, decideUpdate } from "./updatemath";

const DISMISS_KEY = "pcremote.updateDismissed";
const APP_VERSION = String(Constants?.expoConfig?.version || "");

async function fetchLatest() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export default function UpdateBanner() {
  const insets = useSafeAreaInsets();
  const [release, setRelease] = useState(null);
  const [pcVersion, setPcVersion] = useState(() => String(getStatus().hello?.version || ""));
  const [dismissed, setDismissed] = useState(null); // null = not loaded yet
  const lastCheck = useRef(0);
  // Touch shield: taps here never reach a viewer gesture underneath.
  const shield = useMemo(() => Gesture.Manual(), []);

  useEffect(() => {
    if (__DEV__ || !APP_VERSION) return undefined;
    SecureStore.getItemAsync(DISMISS_KEY)
      .then((v) => setDismissed(v || ""))
      .catch(() => setDismissed(""));
    const check = () => {
      if (Date.now() - lastCheck.current < CHECK_EVERY_MS) return;
      lastCheck.current = Date.now();
      void fetchLatest().then((r) => {
        if (r) setRelease(r);
        else lastCheck.current = 0; // offline: try again next time the app opens
      });
    };
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    const off = addListener((e) => {
      if (e.t === "hello") setPcVersion(String(e.hello?.version || ""));
    });
    return () => {
      sub.remove();
      off();
    };
  }, []);

  if (dismissed === null) return null;
  const upd = decideUpdate({ appVersion: APP_VERSION, release, pcVersion, dismissed });
  if (!upd) return null;

  const later = () => {
    setDismissed(upd.tag);
    SecureStore.setItemAsync(DISMISS_KEY, upd.tag).catch(() => {});
  };
  const sub = upd.source === "pc" ? `PC sudah ${upd.tag}, app ini masih v${APP_VERSION}.` : `Kamu memakai v${APP_VERSION}. Unduh APK, lalu pasang.`;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 8 }]}>
      <GestureDetector gesture={shield}>
        <Animated.View collapsable={false} entering={FadeInUp.duration(220)} exiting={FadeOutUp.duration(160)} style={styles.card}>
          <View style={styles.texts}>
            <Text style={styles.title}>Versi baru {upd.tag} tersedia</Text>
            <Text style={styles.sub}>{sub}</Text>
          </View>
          <PressScale onPress={later} style={styles.later} accessibilityLabel="Nanti">
            <Text style={styles.laterText}>Nanti</Text>
          </PressScale>
          <PressScale onPress={() => Linking.openURL(upd.url).catch(() => {})} style={styles.get} accessibilityLabel={`Unduh ${upd.tag}`}>
            <Text style={styles.getText}>Unduh</Text>
          </PressScale>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12, zIndex: 50, elevation: 50 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#3a3a3e",
    borderRadius: 14,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 10,
  },
  texts: { flex: 1, gap: 2 },
  title: { color: COLORS.text, fontWeight: "700", fontSize: 14 },
  sub: { color: COLORS.muted, fontSize: 12 },
  later: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10 },
  laterText: { color: COLORS.muted, fontWeight: "700", fontSize: 13 },
  get: { backgroundColor: COLORS.fill, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10 },
  getText: { color: "#fff", fontWeight: "800", fontSize: 13 },
});
