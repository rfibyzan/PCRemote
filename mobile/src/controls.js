/** Shared streaming controls: Quality/FPS + stats + monitor source + Wide/Portrait.
 * One centralized quality store (existing `quality` message + pcremote.quality
 * persistence) shared by PAD / TYPE / GAME / WIN. No second quality system.
 */
import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { COLORS } from "./components";
import { STORE_QUALITY, msg } from "./protocol";
import { addListener, getStatus, send } from "./connection";
import { useStreamStats } from "./cursor";

// Preset mapping onto the EXISTING agent backend:
// Low = lite (Q18/6fps), Mid = low (Q26/13fps), High = high (Q40/22fps).
const PRESET_Q = { Low: "lite", Mid: "low", High: "high" };
const BASE_Q = { lite: 18, low: 26, med: 26, high: 40, super: 40 };
const BASE_FPS = { lite: 6, low: 13, med: 13, high: 22, super: 22 };
const Q_TO_PRESET = { lite: "Low", low: "Mid", med: "Mid", high: "High", super: "High" };

function clampQStep(v) {
  return Math.max(-5, Math.min(8, Math.round(Number(v) || 0)));
}
function clampFpsStep(v) {
  return Math.max(-5, Math.min(10, Math.round(Number(v) || 0)));
}
export function qValue(q, qStep) {
  return Math.max(18, Math.min(92, Math.round((BASE_Q[q] ?? 26) + clampQStep(qStep) * 8)));
}
export function fpsValue(q, fpsStep) {
  return Math.max(1, Math.min(30, Math.round((BASE_FPS[q] ?? 13) + clampFpsStep(fpsStep) * 2)));
}

/**
 * Effective FPS estimate mirroring runtime/agent encodeProfile() base
 * selection (before tune). Agent may lower fps for remote (tunnel) and for
 * cropped/uncropped combos to save data. Showing raw BASE_FPS as "target"
 * is what made users think "22fps setting but 9 real = bug".
 * Use effectiveFps() for display + rebase timing; keep fpsValue() as the
 * raw user-requested value for transparency.
 */
function encodeBaseFps(q, remote, cropped) {
  const key = q === "super" ? "high" : q === "high" ? "high" : q === "lite" ? "lite" : "low";
  let base;
  if (key === "lite") {
    if (cropped) base = remote ? 4 : 6;
    else base = remote ? 4 : 6;
  } else if (key === "high") {
    if (cropped) base = remote ? 14 : 22;
    else base = remote ? 14 : 22;
  } else {
    if (cropped) base = remote ? 8 : 13;
    else base = remote ? 8 : 13;
  }
  return base;
}

export function effectiveFpsValue(q, fpsStep, { remote = false, cropped = false } = {}) {
  const base = encodeBaseFps(q, remote, cropped);
  return Math.max(1, Math.min(30, Math.round(base + clampFpsStep(fpsStep) * 2)));
}

export function isRemoteLink(link) {
  return String(link || "").toLowerCase() === "remote";
}

// Last quality-ack pushed by the agent ({effective, link, cropped}).
const ackState = { effective: null, link: "", cropped: false, at: 0 };
const ackListeners = new Set();

function emitAck() {
  for (const fn of [...ackListeners]) {
    try {
      fn({ ...ackState });
    } catch {
      // ignore
    }
  }
}

// Agent sends {t:"qualityAck", effective:{width,quality,fps}, link, cropped}.
addListener((event) => {
  if (event.t === "qualityAck" && event.effective) {
    ackState.effective = event.effective;
    ackState.link = String(event.link || "");
    ackState.cropped = Boolean(event.cropped);
    ackState.at = Date.now();
    emitAck();
    return;
  }
  // Link/path changed (wifi<->remote) or fresh auth: the stored ack describes
  // the OLD path — clear it so the stats line falls back to the local
  // estimate instead of showing a stale effective fps.
  if (event.t === "hello" || event.t === "close") {
    if (ackState.at) {
      ackState.effective = null;
      ackState.link = "";
      ackState.cropped = false;
      ackState.at = 0;
      emitAck();
    }
  }
});

export function useQualityAck() {
  const [s, setS] = useState({ ...ackState });
  useEffect(() => {
    const fn = (n) => setS({ ...n });
    ackListeners.add(fn);
    return () => ackListeners.delete(fn);
  }, []);
  return s;
}
export function presetLabel(q, qStep, fpsStep) {
  if (clampQStep(qStep) === 0 && clampFpsStep(fpsStep) === 0) return Q_TO_PRESET[q] || "Mid";
  return "Custom";
}

// ---- Centralized store: every StreamControls instance shows the same values.
const qState = { q: "low", qStep: 0, fpsStep: 0, loaded: false };
const qListeners = new Set();

function emitQ() {
  for (const fn of [...qListeners]) {
    try {
      fn({ q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep });
    } catch {
      // one bad subscriber must not break the rest
    }
  }
}

function loadQualityOnce() {
  if (qState.loaded) return;
  qState.loaded = true;
  SecureStore.getItemAsync(STORE_QUALITY).then((raw) => {
    try {
      const saved = JSON.parse(raw || "null");
      if (saved?.q && BASE_Q[saved.q] != null) {
        qState.q = saved.q;
        qState.qStep = clampQStep(saved.qStep);
        qState.fpsStep = clampFpsStep(saved.fpsStep);
        emitQ();
      }
    } catch {
      // defaults
    }
  }).catch(() => {});
}

export function getQuality() {
  return { q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep };
}

export function applyQuality(q, qs, fs) {
  qState.q = BASE_Q[q] != null ? q : "low";
  qState.qStep = clampQStep(qs);
  qState.fpsStep = clampFpsStep(fs);
  // Agent budgets by link (remote vs wifi) — always tell it which path we use.
  // Without this the PC silently assumes wifi and the effective-fps display
  // can never match reality on a tunnel.
  let link = "";
  try {
    link = getStatus().link || "";
  } catch {
    link = "";
  }
  send(msg.quality(link ? { q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep, link } : { q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep }));
  SecureStore.setItemAsync(
    STORE_QUALITY,
    JSON.stringify({ q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep }),
  ).catch(() => {});
  emitQ();
}

// Re-assert current quality + link whenever the socket (re)authenticates or
// the path changes (wifi<->remote). Without this a reconnect silently drops
// back to the agent's wifi default and remote stays over-budget.
const _linkSync = { last: "" };
addListener((event) => {
  if (event.t !== "hello" && event.t !== "status" && event.t !== "progress") return;
  let link = "";
  try {
    link = getStatus().link || "";
  } catch {
    return;
  }
  if (event.t === "hello" || (link && link !== _linkSync.last)) {
    _linkSync.last = link;
    try {
      send(msg.quality(link ? { q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep, link } : { q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep }));
    } catch {
      // best-effort
    }
  }
});

export function useQuality() {
  const [s, setS] = useState({ q: qState.q, qStep: qState.qStep, fpsStep: qState.fpsStep });
  useEffect(() => {
    loadQualityOnce();
    const fn = (n) => setS({ ...n });
    qListeners.add(fn);
    return () => qListeners.delete(fn);
  }, []);
  return s;
}

function fmtBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
function fmtRate(bps) {
  return bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

/** "12.4 MB · 386 KB/s · Q24 · 22→14fps (9 real)" — target→efektif vs real.
 * Efektif = anggaran agent (remote/cropped). Real rendah saat layar statis
 * adalah hemat-bandwidth by design (fingerprint dedup), bukan bug. */
export function StreamStats() {
  const { total, rate, fps } = useStreamStats();
  const { q, qStep, fpsStep } = useQuality();
  const ack = useQualityAck();
  const selCrop = useSel().crop;
  const [link, setLink] = React.useState(getStatus().link || "");
  React.useEffect(() => {
    return addListener((e) => {
      if (e.t === "status" || e.t === "progress" || e.t === "hello") setLink(getStatus().link || "");
    });
  }, []);
  const target = fpsValue(q, fpsStep);
  const remote = isRemoteLink(ack.link || link);
  const cropped = ack.at ? ack.cropped : Boolean(selCrop && (selCrop.w < 0.995 || selCrop.h < 0.995));
  const effFromAgent = ack.effective?.fps;
  const effLocal = effectiveFpsValue(q, fpsStep, { remote, cropped });
  const eff = Number.isFinite(Number(effFromAgent)) ? Number(effFromAgent) : effLocal;
  const staticHint = fps <= 1 && rate < 15000 && total > 0 ? " · statis" : "";
  const effPart = eff !== target ? `→${eff}` : "";
  return (
    <Text style={styles.stats}>
      {fmtBytes(total)} · {fmtRate(rate)} · Q{qValue(q, qStep)} · {target}{effPart}fps ({fps} real{staticHint})
    </Text>
  );
}

export function StreamControls({ compact }) {
  const { q, qStep, fpsStep } = useQuality();
  const [pickOpen, setPickOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const label = presetLabel(q, qStep, fpsStep);

  // Steppers apply only when the COMPUTED value actually changes, so the
  // internal step counter can never run past the display/backend max/min
  // (no phantom extra clicks to come back down from 30fps / Q92).
  function stepQ(d) {
    const n = qStep + d;
    if (qValue(q, n) !== qValue(q, qStep)) applyQuality(q, n, fpsStep);
  }
  function stepFps(d) {
    const n = fpsStep + d;
    if (fpsValue(q, n) !== fpsValue(q, fpsStep)) applyQuality(q, qStep, n);
  }

  // Collapsed by default: preset + stats in one line.
  // Tap the text to expand the full controls.
  if (!expanded) {
    return (
      <View style={[styles.box, compact && styles.boxCompact]}>
        <Pressable onPress={() => setExpanded(true)} style={styles.summary}>
          <Text style={styles.summaryText}>{label} ▾</Text>
          <View style={styles.summaryStats}>
            <StreamStats />
          </View>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.box, compact && styles.boxCompact]}>
      <View style={styles.presets}>
        <Pressable onPress={() => setPickOpen(true)} style={styles.dropBtn}>
          <Text style={styles.dropText}>{label} ▾</Text>
        </Pressable>
        <View style={styles.stepper}>
          <Pressable onPress={() => stepQ(1)} style={styles.stepBtn}>
            <Text style={styles.stepBtnText}>▲</Text>
          </Pressable>
          <Text style={styles.stepValue}>Q {qValue(q, qStep)}</Text>
          <Pressable onPress={() => stepQ(-1)} style={styles.stepBtn}>
            <Text style={styles.stepBtnText}>▼</Text>
          </Pressable>
        </View>
        <View style={styles.stepper}>
          <Pressable onPress={() => stepFps(1)} style={styles.stepBtn}>
            <Text style={styles.stepBtnText}>▲</Text>
          </Pressable>
          <Text style={styles.stepValue}>fps {fpsValue(q, fpsStep)}</Text>
          <Pressable onPress={() => stepFps(-1)} style={styles.stepBtn}>
            <Text style={styles.stepBtnText}>▼</Text>
          </Pressable>
        </View>
      </View>
      {/* Tap the stats line to collapse back to the summary. */}
      <Pressable onPress={() => setExpanded(false)}>
        <StreamStats />
      </Pressable>
      <Modal visible={pickOpen} transparent animationType="fade" onRequestClose={() => setPickOpen(false)}>
        <Pressable style={styles.modalShade} onPress={() => setPickOpen(false)}>
          <View style={styles.modalBox}>
            {["Low", "Mid", "High"].map((p) => (
              <Pressable
                key={p}
                onPress={() => {
                  applyQuality(PRESET_Q[p], 0, 0);
                  setPickOpen(false);
                }}
                style={[styles.modalItem, label === p && styles.modalItemActive]}
              >
                <Text style={[styles.modalText, label === p && styles.modalTextActive]}>{p}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Monitor/source selector state: All | 1..n | Cam. Cam uses the same viewer.
 * Source/mode/bar/click-button/crop are SHARED across PAD/TYPE/WIN tabs via
 * the module store below, so switching tabs never desyncs the UI.
 */
const sel = {
  source: undefined, // undefined = not yet known, follow agent hello
  mode: "Click",
  bar: false,
  clickBtn: "left",
  crop: { x: 0, y: 0, w: 1, h: 1 },
  gameLock: false, // true while GAME owns the crop (Fit/restore transaction)
};
const selListeners = new Set();

function emitSel() {
  for (const fn of [...selListeners]) {
    try {
      fn({ ...sel, crop: { ...sel.crop } });
    } catch {
      // one bad subscriber must not break the rest
    }
  }
}

export function getSel() {
  return { ...sel, crop: { ...sel.crop } };
}

export function setSel(patch) {
  Object.assign(sel, patch);
  if (patch.crop) sel.crop = { ...patch.crop };
  emitSel();
}

export function useSel() {
  const [s, setS] = useState({
    source: sel.source,
    mode: sel.mode,
    bar: sel.bar,
    clickBtn: sel.clickBtn,
    crop: { ...sel.crop },
  });
  useEffect(() => {
    const fn = (n) => setS({ ...n, crop: { ...n.crop } });
    selListeners.add(fn);
    return () => selListeners.delete(fn);
  }, []);
  return s;
}

export function useMonitorSource() {
  const s = useSel();
  const [monitors, setMonitors] = useState(() => getStatus().hello?.monitors || []);
  const [camError, setCamError] = useState("");
  const current = s.source !== undefined ? s.source : (() => {
    const primary = getStatus().hello?.monitors?.find((m) => m.primary);
    return primary ? primary.id : 0;
  })();

  useEffect(() => {
    return addListener((event) => {
      if (event.t === "hello") {
        setMonitors(event.hello.monitors || []);
        const primary = (event.hello.monitors || []).find((m) => m.primary);
        if (getSel().source === undefined) setSel({ source: primary ? primary.id : 0 });
      }
      if (event.t === "monitors") {
        setMonitors(event.monitors || []);
        // current was set optimistically in pick(); accept the agent echo.
        if (event.current !== undefined && event.current !== null) setSel({ source: event.current });
      }
      if (event.t === "cam") {
        if (event.on) {
          setSel({ source: "cam" });
          setCamError("");
        } else {
          setCamError(event.error || "");
          if (getSel().source === "cam") setSel({ source: 0 });
        }
      }
    });
  }, []);

  function pick(id) {
    const was = getSel().source;
    setSel({ source: id }); // optimistic: never leave the UI stuck on "cam"
    if (id === "cam") {
      send(msg.cam(true));
      return;
    }
    if (was === "cam") send(msg.cam(false));
    send(msg.monitor(id));
    send(msg.screen(true)); // re-assert the screen subscription (idempotent)
  }

  return { monitors, current, camError, pick };
}

/** Tiny connection status dot for headers (connected / retrying / idle). */
export function ConnDot() {
  const [st, setSt] = useState(getStatus());
  useEffect(() => {
    return addListener((event) => {
      if (event.t === "status" || event.t === "hello" || event.t === "close") setSt(getStatus());
    });
  }, []);
  const color = st.connected ? COLORS.ok : st.status === "reconnecting" ? "#facc15" : COLORS.muted;
  const glyph = st.connected ? "●" : st.status === "reconnecting" ? "↻" : "○";
  return <Text style={[styles.connDot, { color }]}>{glyph}</Text>;
}

const styles = StyleSheet.create({
  box: { backgroundColor: COLORS.card, borderRadius: 12, padding: 8, gap: 6, marginHorizontal: 8, marginTop: 0, position: "relative" },
  summary: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  summaryStats: { flex: 1 },
  summaryText: { color: COLORS.text, fontWeight: "800", fontSize: 13 },
  presets: { flexDirection: "row", gap: 6, alignItems: "center" },
  dropBtn: { backgroundColor: "#0c4a6e", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  dropText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  stepper: { flex: 1, flexDirection: "row", backgroundColor: COLORS.chip, borderRadius: 10, paddingVertical: 4, paddingHorizontal: 4, alignItems: "center", justifyContent: "space-between" },
  stepBtn: { borderRadius: 8, width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: COLORS.muted, fontSize: 12, fontWeight: "800" },
  stepValue: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  stats: { color: COLORS.muted, fontSize: 11, fontWeight: "700", textAlign: "center" },
  modalShade: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  modalBox: { backgroundColor: COLORS.card, borderRadius: 14, padding: 8, gap: 4, minWidth: 200 },
  modalItem: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
  modalItemActive: { backgroundColor: "#0c4a6e" },
  modalText: { color: COLORS.muted, fontWeight: "800", fontSize: 14 },
  modalTextActive: { color: COLORS.text },
  wideBtn: { backgroundColor: COLORS.chip, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14 },
  wideText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  connDot: { fontSize: 12, fontWeight: "800" },
});
