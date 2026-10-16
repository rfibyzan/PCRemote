/** Full-screen QR scanner for pairing (expo-camera). expo-camera is a native
 * module: on an older build without it the require fails and we show a hint
 * instead of crashing (the phone camera app + deep link still works).
 */
import React, { useRef } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Pulse, popIn } from "../motion";
import Text from "../AppText";
import { COLORS } from "../components";
import { parsePairQr } from "../pairqr";

let Camera = null;
try {
  Camera = require("expo-camera");
} catch {
  Camera = null;
}

export default function QrScanner({ visible, onClose, onResult }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {visible && (Camera ? <ScanBody onResult={onResult} /> : <NoCamera />)}
        <Pressable onPress={onClose} style={styles.close} hitSlop={8}>
          <Text style={styles.closeText}>Tutup</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function NoCamera() {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>Scanner belum tersedia</Text>
      <Text style={styles.hint}>Build APK ini belum berisi kamera. Pakai aplikasi kamera HP untuk scan QR di PC, atau ketik kodenya.</Text>
    </View>
  );
}

function ScanBody({ onResult }) {
  const [perm, requestPerm] = Camera.useCameraPermissions();
  const done = useRef(false);
  const [bad, setBad] = React.useState(false);
  const [ok, setOk] = React.useState(false); // brief green tick before the scanner closes
  const okTimer = useRef(null);
  React.useEffect(() => () => clearTimeout(okTimer.current), []); // closed during the tick = no result

  if (!perm) return <View style={styles.center} />;
  if (!perm.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Izin kamera</Text>
        <Text style={styles.hint}>Kamera dipakai hanya untuk membaca QR di layar PC.</Text>
        <Pressable onPress={requestPerm} style={styles.btn}>
          <Text style={styles.btnText}>Izinkan kamera</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={StyleSheet.absoluteFill}>
      <Camera.CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const r = parsePairQr(data);
          if (!r) {
            setBad(true);
            return;
          }
          done.current = true;
          setOk(true);
          okTimer.current = setTimeout(() => onResult(r), 450);
        }}
      />
      <View style={styles.frameWrap} pointerEvents="none">
        <Pulse on={!ok} min={0.7} grow={1.03} ms={900}>
          <View style={[styles.frame, ok && styles.frameOk]}>
            {ok && (
              <Animated.View entering={popIn} style={styles.tick}>
                <MaterialCommunityIcons name="check-bold" size={44} color="#fff" />
              </Animated.View>
            )}
          </View>
        </Pulse>
        <Animated.View key={ok ? "ok" : bad ? "bad" : "aim"} entering={FadeIn.duration(160)}>
          <Text style={styles.frameText}>{ok ? "QR terbaca, menghubungkan…" : bad ? "Itu bukan QR PC Remote" : "Arahkan ke QR di layar PC"}</Text>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 12, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  hint: { color: COLORS.muted, textAlign: "center" },
  btn: { backgroundColor: "#5e5ce6", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18 },
  btnText: { color: "#f2f2f5", fontWeight: "800" },
  frameWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 16 },
  frame: { width: 240, height: 240, borderRadius: 18, borderWidth: 3, borderColor: "#7c7aff", alignItems: "center", justifyContent: "center" },
  frameOk: { borderColor: "#34c759" },
  tick: { width: 84, height: 84, borderRadius: 42, backgroundColor: "#34c759", alignItems: "center", justifyContent: "center" },
  frameText: { color: "#fff", fontWeight: "800", backgroundColor: "rgba(0,0,0,0.55)", paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  close: { position: "absolute", top: 44, right: 18, backgroundColor: "rgba(22,22,24,0.85)", borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  closeText: { color: "#f2f2f5", fontWeight: "800" },
});
