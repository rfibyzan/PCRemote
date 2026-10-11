/** WEBCAM: remote camera view + screen chips to go back. */
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { COLORS, MonitorChips, ScreenView } from "../components";
import { msg } from "../protocol";
import { addListener, send } from "../connection";

export default function WebcamScreen() {
  const [on, setOn] = useState(false);
  const [error, setError] = useState("");
  const [monitors, setMonitors] = useState([]);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    send(msg.cam(true));
    const off = addListener((event) => {
      if (event.t === "cam") {
        setOn(Boolean(event.on));
        setError(event.error || "");
      }
      if (event.t === "hello") setMonitors(event.hello.monitors || []);
      if (event.t === "monitors") {
        setMonitors(event.monitors || []);
        setCurrent(event.current ?? 0);
      }
    });
    return () => {
      off();
      send(msg.cam(false));
    };
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.hint}>Webcam: drag to look, pinch to zoom. Tap a screen chip to go back.</Text>
      <ScreenView style={styles.screen} />
      {!!error && <Text style={styles.error}>{error}</Text>}
      {!on && !error && <Text style={styles.hint}>Starting webcam…</Text>}
      <MonitorChips monitors={monitors} current={current} onPick={(id) => send(msg.monitor(id))} />
      <Pressable onPress={() => send(msg.cam(true))} style={styles.retry}>
        <Text style={styles.retryText}>Restart camera</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  hint: { color: COLORS.muted, fontSize: 12, padding: 8 },
  screen: { flex: 1, margin: 8, borderRadius: 12 },
  error: { color: COLORS.danger, padding: 8, textAlign: "center" },
  retry: { backgroundColor: COLORS.chip, borderRadius: 12, padding: 12, margin: 8, alignItems: "center" },
  retryText: { color: COLORS.text, fontWeight: "700" },
});
