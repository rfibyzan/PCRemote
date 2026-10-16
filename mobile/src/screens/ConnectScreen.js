/** Pairing / connection screen.
 * First pair: scan the QR on the PC dashboard (or type the code once).
 * Paired: connects by itself; every step shows in the live log below, so a
 * failed connect always says where it stopped (and the log can be shared).
 * Recent PCs connect with one tap; Log out forgets the current PC.
 */
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";
import { PressScale, Pulse, popIn } from "../motion";
import Text from "../AppText";
import { COLORS } from "../components";
import {
  addListener,
  boot,
  cancelFind,
  clearPairing,
  connectToCode,
  forgetRecent,
  getStatus,
  retryConnect,
} from "../connection";
import { normalizeCode } from "../protocol";
import { formatCodeInput, fromParams } from "../pairqr";
import QrScanner from "./QrScanner";
import { LogPanel, RecentList, useRecent } from "./ConnPanels";

const BUSY_STATES = new Set(["connecting", "reconnecting"]);
const STOP_STATES = new Set(["kicked", "blocked", "rejected", "stopped"]);

export default function ConnectScreen({ onConnected, qrParams = null }) {
  const [code, setCode] = useState("");
  const [st, setSt] = useState(getStatus());
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const qrDone = useRef("");
  const recent = useRecent();
  const paired = Boolean(st.code);

  useEffect(() => {
    boot().then(() => {
      const s = getStatus();
      setSt(s);
      const fromLink = qrParams ? fromParams(qrParams) : null;
      if (fromLink) {
        qrDone.current = `${qrParams.c}|${qrParams.h}`;
        void run(fromLink.code, fromLink.hosts);
      } else if (s.code && !BUSY_STATES.has(s.status) && !STOP_STATES.has(s.status)) {
        // Paired: connect right away. Skipped while the connection is
        // already retrying (no second connect racing it) and after the PC
        // kicked / blocked us (the user decides).
        void run(s.code);
      }
    });
    return addListener((event) => {
      if (event.t === "hello") onConnected();
      if (event.t === "status" || event.t === "progress" || event.t === "failed" || event.t === "code" || event.t === "close") {
        setSt(getStatus());
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(rawCode, hosts = []) {
    const clean = normalizeCode(rawCode);
    if (clean.length < 8) return;
    setBusy(true);
    try {
      await connectToCode(clean, { hosts });
    } catch {
      // the reason is already in the log / status
    } finally {
      setBusy(false);
      setSt(getStatus());
    }
  }

  function onConnectPress() {
    if (paired) return run(st.code);
    const clean = normalizeCode(code);
    if (clean.length < 8) return;
    return run(clean);
  }

  // A second deep link while this screen is open (app already running).
  useEffect(() => {
    if (!qrParams) return;
    const key = `${qrParams.c}|${qrParams.h}`;
    if (qrDone.current === key) return;
    const r = fromParams(qrParams);
    if (!r) return;
    qrDone.current = key;
    void run(r.code, r.hosts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrParams?.c, qrParams?.h]);

  function onQr(r) {
    setScanOpen(false);
    setCode(formatCodeInput(r.code));
    void run(r.code, r.hosts);
  }

  const working = busy || BUSY_STATES.has(st.status);
  const statusColor = STOP_STATES.has(st.status) || st.status === "failed" || st.status === "unreachable" ? COLORS.danger : working ? "#facc15" : COLORS.muted;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>PC Remote</Text>
      {paired ? (
        <Text style={styles.hint}>
          {st.pcName ? `Terhubung ke ${st.pcName}` : "Sudah dipasangkan"} ✓ — HP akan menyambung sendiri selama PCRemote.exe jalan.
        </Text>
      ) : (
        <Text style={styles.hint}>Buka dashboard PC Remote di PC, lalu scan QR-nya. Cukup sekali.</Text>
      )}

      {!paired && (
        <PressScale onPress={() => setScanOpen(true)} style={styles.scanBig}>
          <Text style={styles.scanBigText}>▣  Scan QR di layar PC</Text>
        </PressScale>
      )}

      {!paired && (
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={(t) => setCode(formatCodeInput(t))}
          placeholder="atau ketik kode: ABCD 2345"
          placeholderTextColor={COLORS.muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          keyboardType="visible-password"
          maxLength={9}
        />
      )}

      <View style={styles.row}>
        <Pulse on={working} min={0.6} style={styles.flex}>
        <PressScale
          style={[styles.primary, styles.noFlex, working && styles.primaryBusy, !paired && normalizeCode(code).length < 8 && styles.primaryOff]}
          onPress={onConnectPress}
          disabled={working || (!paired && normalizeCode(code).length < 8)}
        >
          <Text style={styles.primaryText}>{working ? "Menghubungkan…" : STOP_STATES.has(st.status) ? "Connect lagi" : "Connect"}</Text>
        </PressScale>
        </Pulse>
        {working && (
          <Animated.View entering={popIn} exiting={FadeOut.duration(120)}>
          <PressScale
            onPress={() => {
              cancelFind();
              setBusy(false);
            }}
            style={styles.cancel}
          >
            <Text style={styles.cancelText}>Batal</Text>
          </PressScale>
          </Animated.View>
        )}
      </View>

      <Text style={[styles.status, { color: statusColor }]}>
        {st.status}
        {st.stage && st.stage !== st.status ? ` · ${st.stage}` : ""}
        {st.link ? ` · ${st.link}` : ""}
        {st.attempts ? ` · coba ${st.attempts}` : ""}
      </Text>
      {!!st.detail && (
        <Animated.View key={st.detail} entering={FadeIn.duration(180)}>
          <Text style={styles.message}>{st.detail}</Text>
        </Animated.View>
      )}

      {(st.status === "failed" || st.status === "unreachable" || st.status === "reconnecting") && !busy && (
        <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOut.duration(150)}>
          <PressScale onPress={() => retryConnect()} style={styles.retry}>
            <Text style={styles.retryText}>Coba lagi sekarang</Text>
          </PressScale>
        </Animated.View>
      )}

      <LogPanel lines={8} />

      <RecentList
        recent={recent.filter((r) => r.code !== st.code)}
        currentCode={st.code}
        busy={working}
        onConnect={(r) => run(r.code)}
        onForget={(r) => forgetRecent(r.code)}
      />

      {paired && (
        <View style={styles.row}>
          <PressScale onPress={() => setScanOpen(true)} style={[styles.scan, styles.flex]}>
            <Text style={styles.scanText}>▣  Scan QR PC lain</Text>
          </PressScale>
          <PressScale
            onPress={() => {
              clearPairing();
              setCode("");
            }}
            style={styles.logout}
          >
            <Text style={styles.logoutText}>Log out</Text>
          </PressScale>
        </View>
      )}
      <QrScanner visible={scanOpen} onClose={() => setScanOpen(false)} onResult={onQr} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  root: { flexGrow: 1, padding: 24, paddingTop: 56, justifyContent: "center", gap: 12 },
  title: { color: COLORS.text, fontSize: 28, fontWeight: "800" },
  hint: { color: COLORS.muted, fontSize: 13 },
  input: { backgroundColor: COLORS.card, color: COLORS.text, borderRadius: 12, padding: 14, fontSize: 20, letterSpacing: 3, textAlign: "center" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  flex: { flex: 1 },
  noFlex: { flex: 0 }, // primary sits inside Pulse, which carries the flex
  primary: { flex: 1, backgroundColor: "#5e5ce6", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  primaryBusy: { backgroundColor: "#5e5ce6" },
  primaryOff: { backgroundColor: "#2c2c30" },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  cancel: { backgroundColor: "#7f1d1d", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  cancelText: { color: "#f2f2f5", fontWeight: "800" },
  status: { textAlign: "center", fontSize: 12, fontWeight: "700" },
  message: { color: COLORS.accent, textAlign: "center" },
  retry: { backgroundColor: "#5e5ce6", borderRadius: 10, padding: 12, alignItems: "center" },
  retryText: { color: "#f2f2f5", fontWeight: "800" },
  scanBig: { backgroundColor: "#5e5ce6", borderWidth: 1, borderColor: "#7c7aff", borderRadius: 14, paddingVertical: 18, alignItems: "center" },
  scanBigText: { color: "#ffffff", fontWeight: "800", fontSize: 16 },
  scan: { borderWidth: 1, borderColor: "#7c7aff", borderRadius: 12, padding: 12, alignItems: "center" },
  scanText: { color: "#a5a1ff", fontWeight: "800" },
  logout: { borderWidth: 1, borderColor: "#7f1d1d", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16 },
  logoutText: { color: COLORS.danger, fontWeight: "800" },
});
