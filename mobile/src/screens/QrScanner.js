/** Full-screen QR scanner for pairing (expo-camera). expo-camera is a native
 * module: on an older build without it the require fails and we show a hint
 * instead of crashing (the phone camera app + deep link still works).
 */
import React, { useRef } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
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
          onResult(r);
        }}
      />
      <View style={styles.frameWrap} pointerEvents="none">
        <View style={styles.frame} />
        <Text style={styles.frameText}>{bad ? "Itu bukan QR PC Remote" : "Arahkan ke QR di layar PC"}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 12, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  hint: { color: COLORS.muted, textAlign: "center" },
  btn: { backgroundColor: "#0c4a6e", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18 },
  btnText: { color: "#e8eefc", fontWeight: "800" },
  frameWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 16 },
  frame: { width: 240, height: 240, borderRadius: 18, borderWidth: 3, borderColor: "#38bdf8" },
  frameText: { color: "#fff", fontWeight: "800", backgroundColor: "rgba(0,0,0,0.55)", paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  close: { position: "absolute", top: 44, right: 18, backgroundColor: "rgba(15,23,42,0.85)", borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  closeText: { color: "#e8eefc", fontWeight: "800" },
});
