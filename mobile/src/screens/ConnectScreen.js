/** Pairing / connection screen with detailed staged progress.
 * First pair: enter the code shown on the PC tray (only moment the phone
 * ever shows a code field). Once paired, the code is never displayed —
 * only the PC may show it. Manual host entry kept as last-resort fallback.
 */
import React, { useEffect, useRef, useState } from "react";
import { Button, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { COLORS } from "../components";
import {
  boot,
  cancelFind,
  clearPairing,
  connect,
  findPC,
  getStatus,
  probeHost,
  retryConnect,
  setLockCode,
  addListener,
} from "../connection";
import { normalizeCode } from "../protocol";

export default function ConnectScreen({ onConnected }) {
  const [code, setCode] = useState("");
  const [paired, setPaired] = useState(false);
  const [status, setStatus] = useState("idle");
  const [detail, setDetail] = useState("");
  const [stage, setStage] = useState("idle");
  const [link, setLink] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [lastError, setLastError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const [showManual, setShowManual] = useState(false);
  const savedRef = useRef("");

  function syncStatus(s) {
    setStatus(s.status);
    setDetail(s.detail || "");
    setStage(s.stage || s.status);
    setLink(s.link || "");
    setAttempts(s.attempts || 0);
    setLastError(s.lastError || "");
  }

  useEffect(() => {
    boot().then(() => {
      const s = getStatus();
      if (s.code) {
        savedRef.current = s.code;
        setPaired(true);
        // Already paired: look for the PC immediately (original behavior).
        if (s.hosts.length) pairAndConnect(s.code);
      }
      syncStatus(s);
    });
    return addListener((event) => {
      if (event.t === "hello") onConnected();
      if (event.t === "status" || event.t === "progress" || event.t === "failed") syncStatus(getStatus());
      if (event.t === "code") {
        if (event.code) {
          savedRef.current = event.code;
          setPaired(true);
        } else {
          savedRef.current = "";
          setPaired(false);
        }
      }
      if (event.t === "close") setDetail("Terputus. Mencoba lagi…");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pairAndConnect(rawCode) {
    const clean = normalizeCode(rawCode ?? (paired ? savedRef.current : code));
    if (clean.length < 8) {
      setDetail("Enter the code shown on the PC");
      return;
    }
    setBusy(true);
    setDetail("Mencari PC…");
    setLastError("");
    await setLockCode(clean);
    try {
      const url = await findPC(setDetail);
      setDetail(`Ketemu, menghubungkan…`);
      connect(url);
    } catch (e) {
      const m = String(e?.message || e);
      if (m.includes("cancelled")) {
        setDetail("Dibatalkan.");
      } else {
        setDetail("PC tidak ketemu.");
        setLastError(m);
        setShowManual(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function connectManual() {
    const h = manual.trim();
    if (!h) return;
    setBusy(true);
    try {
      const url = await probeHost(h);
      connect(url);
      setDetail(`Menghubungkan manual ke ${h}…`);
    } catch (e) {
      setLastError(`manual gagal: ${String(e?.message || e)} (pastikan IP:port benar + satu Wi-Fi + firewall allow)`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>PC Remote</Text>
      {paired ? (
        <Text style={styles.hint}>Paired ✓ — only the PC shows the pair code.</Text>
      ) : (
        <Text style={styles.hint}>On the PC, open the tray icon and enter this code once. It stays locked after restarts.</Text>
      )}
      {!paired && (
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="ABCD 2345"
          placeholderTextColor={COLORS.muted}
          autoCapitalize="characters"
          maxLength={9}
        />
      )}
      <View style={styles.row}>
        <View style={styles.btnFlex}>
          <Button title={busy ? "Mencari… (tap Batal)" : "Connect"} onPress={() => pairAndConnect()} disabled={false} />
        </View>
        {busy && (
          <Pressable
            onPress={() => {
              cancelFind();
              setBusy(false);
              setDetail("Dibatalkan.");
            }}
            style={styles.cancel}
          >
            <Text style={styles.cancelText}>Batal</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.status}>
        Status: {status}
        {stage && stage !== status ? ` · ${stage}` : ""}
        {link ? ` · ${link}` : ""}
        {attempts ? ` · coba ${attempts}` : ""}
        {paired ? " · Paired" : ""}
      </Text>
      {!!detail && <Text style={styles.message}>{detail}</Text>}
      {!!lastError && <Text style={styles.error}>{lastError}</Text>}
      {(status === "failed" || status === "unreachable" || status === "reconnecting") && !busy && (
        <Pressable onPress={() => retryConnect()} style={styles.retry}>
          <Text style={styles.retryText}>Coba lagi sekarang</Text>
        </Pressable>
      )}
      <Pressable onPress={() => setShowManual((s) => !s)} style={styles.manualToggle}>
        <Text style={styles.manualToggleText}>{showManual ? "Sembunyikan host manual ▾" : "Host manual ▸"}</Text>
      </Pressable>
      {showManual && (
        <View style={styles.manualRow}>
          <TextInput
            style={styles.manualInput}
            value={manual}
            onChangeText={setManual}
            placeholder="192.168.1.10"
            placeholderTextColor={COLORS.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable onPress={connectManual} style={styles.go}>
            <Text style={styles.goText}>Go</Text>
          </Pressable>
        </View>
      )}
      {paired && (
        <Pressable
          onPress={() => {
            clearPairing();
            setCode("");
            setDetail("");
            setLastError("");
          }}
          style={styles.unpair}
        >
          <Text style={styles.unpairText}>Unpair this PC</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg, padding: 24, justifyContent: "center", gap: 12 },
  title: { color: COLORS.text, fontSize: 28, fontWeight: "800" },
  hint: { color: COLORS.muted, fontSize: 13 },
  input: { backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 12, padding: 14, fontSize: 22, letterSpacing: 4, textAlign: "center" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  btnFlex: { flex: 1 },
  cancel: { backgroundColor: "#7f1d1d", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  cancelText: { color: "#e8eefc", fontWeight: "800" },
  status: { color: COLORS.muted, textAlign: "center" },
  message: { color: COLORS.accent, textAlign: "center" },
  error: { color: COLORS.danger, textAlign: "center", fontSize: 12 },
  retry: { backgroundColor: "#0c4a6e", borderRadius: 10, padding: 12, alignItems: "center" },
  retryText: { color: "#e8eefc", fontWeight: "800" },
  manualToggle: { alignItems: "center", padding: 6 },
  manualToggleText: { color: COLORS.muted, fontWeight: "700" },
  manualRow: { flexDirection: "row", gap: 8 },
  manualInput: { flex: 1, backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 10, padding: 12 },
  go: { backgroundColor: "#0c4a6e", borderRadius: 10, padding: 12, justifyContent: "center" },
  goText: { color: "#e8eefc", fontWeight: "800" },
  unpair: { marginTop: 12, alignItems: "center", padding: 10 },
  unpairText: { color: COLORS.danger, fontWeight: "700" },
});
