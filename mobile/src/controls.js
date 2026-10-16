/** Shared streaming controls: Quality/FPS + stats + monitor source + Wide/Portrait.
 * One centralized quality store (existing `quality` message + pcremote.quality
 * persistence) shared by PAD / TYPE / GAME / WIN. No second quality system.
 */
import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import Text from "./AppText";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { COLORS } from "./components";
import { STORE_QUALITY, msg } from "./protocol";
import { addListener, getStatus, send } from "./connection";
import { useStreamStats } from "./cursor";
import { diagnoseStream, lagStep, lighterQuality } from "./streamdiag";
import { BASE_Q, clampFpsStep, clampQStep, fpsValue, qValue, qualityView } from "./videoproto";

export { diagnoseStream };

// Preset mapping: Low = lite, Mid = low, High = high. The numbers per codec
// (JPEG Q/fps, H.264 bitrate/fps/width) live in videoproto.js (pure, tested).
const PRESET_Q = { Low: "lite", Mid: "low", High: "high" };
const Q_TO_PRESET = { lite: "Low", low: "Mid", med: "Mid", high: "High", super: "High" };
export { qValue, fpsValue };

// Which codec the steppers describe: true while H.264 is confirmed flowing
// (video.js calls setVideoCodecActive), false for JPEG and JPEG fallback.
// Own listener set: quality listeners re-send {t:"video"}, a codec flip must not.
const codecState = { video: false };
const codecListeners = new Set();
export function setVideoCodecActive(on) {
  const v = Boolean(on);
  if (codecState.video === v) return;
  codecState.video = v;
  for (const fn of [...codecListeners]) {
    try {
      fn(v);
    } catch {
      // ignore
    }
  }
}
function useVideoCodec() {
  const [v, setV] = useState(codecState.video);
  useEffect(() => {
    const fn = (n) => setV(n);
    codecListeners.add(fn);
    setV(codecState.video);
    return () => codecListeners.delete(fn);
  }, []);
  return v;
}
function useLink() {
  const [link, setLink] = useState(() => getStatus().link || "");
  useEffect(() => {
    return addListener((e) => {
      if (e.t === "status" || e.t === "progress" || e.t === "hello") setLink(getStatus().link || "");
    });
  }, []);
  return link;
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

/** Subscribe to quality changes outside React (src/video.js). */
export function addQualityListener(fn) {
  qListeners.add(fn);
  return () => qListeners.delete(fn);
}

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

function fmtRate(bps) {
  return bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

/** "Q26 · 19 fps · tampil 6 · PC 18 · 386 KB/s · layar statis"
 * target = budget the PC aims for (agent ack when available), tampil =
 * frames actually displayed, PC = frames the PC sent. */
export function StreamStats() {
  const { rate, fps, recv, pc } = useStreamStats();
  const { q, qStep, fpsStep } = useQuality();
  const video = useVideoCodec();
  const ack = useQualityAck();
  const selCrop = useSel().crop;
  const [link, setLink] = React.useState(getStatus().link || "");
  React.useEffect(() => {
    return addListener((e) => {
      if (e.t === "status" || e.t === "progress" || e.t === "hello") setLink(getStatus().link || "");
    });
  }, []);
  const remote = isRemoteLink(ack.link || link);
  const cropped = ack.at ? ack.cropped : Boolean(selCrop && (selCrop.w < 0.995 || selCrop.h < 0.995));
  const effFromAgent = ack.effective?.fps;
  // H.264: the target is the encoder fps (qualityView), never the JPEG
  // estimate or a qualityAck, which both describe the JPEG pipeline.
  const eff = video
    ? qualityView({ q, qStep, fpsStep }, { video: true, link: ack.link || link }).fps
    : Number.isFinite(Number(effFromAgent))
      ? Number(effFromAgent)
      : effectiveFpsValue(q, fpsStep, { remote, cropped });
  const why = diagnoseStream({ target: eff, shown: fps, recv, pc });
  const pcPart = pc ? ` · PC ${Math.round(pc.sent)}` : "";
  return (
    <Text style={styles.stats} numberOfLines={1}>
      {eff} fps · tampil {fps}
      {pcPart} · {fmtRate(rate)}
      {why ? <Text style={styles.statsWarn}> · {why}</Text> : null}
    </Text>
  );
}

/**
 * Slow-link banner over the viewer (idea from Sill): shown when the PC keeps
 * holding frames back because the network can't take them, with a one-tap
 * lighter quality. ✕ hides it for a minute.
 */
export function LagBanner() {
  const { pc } = useStreamStats();
  const quality = useQuality();
  const lagRef = useRef(null);
  const atRef = useRef(0);
  const [on, setOn] = useState(false);
  const [muteUntil, setMuteUntil] = useState(0);
  useEffect(() => {
    // Step once per NEW PC sample (~2 s), not per 1 s meter tick.
    if (pc && pc.at === atRef.current) return;
    atRef.current = pc?.at || 0;
    lagRef.current = lagStep(lagRef.current, pc);
    setOn(lagRef.current.on);
  }, [pc]);
  if (!on || Date.now() < muteUntil) return null;
  const next = lighterQuality(quality);
  return (
    <View style={styles.lag}>
      <Text style={styles.lagText} numberOfLines={2}>
        Koneksi lambat: frame tertahan di PC.
      </Text>
      {!!next && (
        <Pressable onPress={() => applyQuality(next.q, next.qStep, next.fpsStep)} style={styles.lagBtn} hitSlop={4}>
          <Text style={styles.lagBtnText}>Turunkan kualitas</Text>
        </Pressable>
      )}
      <Pressable onPress={() => setMuteUntil(Date.now() + 60_000)} hitSlop={8} accessibilityLabel="Tutup">
        <Text style={styles.lagX}>✕</Text>
      </Pressable>
    </View>
  );
}

export function StreamControls({ compact }) {
  const { q, qStep, fpsStep } = useQuality();
  const [pickOpen, setPickOpen] = useState(false);
  const video = useVideoCodec();
  const link = useLink();
  const label = presetLabel(q, qStep, fpsStep);
  // Values + limits for the ACTIVE codec (H.264: bitrate/fps up to 60, capped
  // on internet links; JPEG: Q/fps up to 30). A step applies only when the
  // shown value changes, so the counter never runs past a limit (no phantom
  // clicks); qualityView returns null at a limit and the button disables.
  const view = qualityView({ q, qStep, fpsStep }, { video, link });
  const stepQ = (n) => n != null && applyQuality(q, n, fpsStep);
  const stepFps = (n) => n != null && applyQuality(q, qStep, n);

  // Always-visible compact panel: one control row + one stats line.
  return (
    <View style={[styles.box, compact && styles.boxCompact]}>
      <View style={styles.presets}>
        <Pressable onPress={() => setPickOpen(true)} style={styles.dropBtn} hitSlop={4}>
          <Text style={styles.dropText}>{label} ▾</Text>
        </Pressable>
        <View style={styles.stepper}>
          <Pressable onPress={() => stepQ(view.qDown)} disabled={view.qDown == null} style={[styles.stepBtn, view.qDown == null && styles.stepBtnOff]} hitSlop={4}>
            <Text style={styles.stepBtnText}>−</Text>
          </Pressable>
          <View style={styles.stepMid} accessibilityLabel={view.video ? `Bitrate ${view.qText}` : `Kualitas ${view.qText}`}>
            {!!view.qCaption && (
              <Text style={styles.stepCaption} numberOfLines={1}>
                {view.qCaption}
              </Text>
            )}
            <Text style={styles.stepValue} numberOfLines={1}>
              {view.qText}
            </Text>
          </View>
          <Pressable onPress={() => stepQ(view.qUp)} disabled={view.qUp == null} style={[styles.stepBtn, view.qUp == null && styles.stepBtnOff]} hitSlop={4}>
            <Text style={styles.stepBtnText}>+</Text>
          </Pressable>
        </View>
        <View style={styles.stepper}>
          <Pressable onPress={() => stepFps(view.fpsDown)} disabled={view.fpsDown == null} style={[styles.stepBtn, view.fpsDown == null && styles.stepBtnOff]} hitSlop={4}>
            <Text style={styles.stepBtnText}>−</Text>
          </Pressable>
          <Text style={styles.stepValue}>{view.fpsText}</Text>
          <Pressable onPress={() => stepFps(view.fpsUp)} disabled={view.fpsUp == null} style={[styles.stepBtn, view.fpsUp == null && styles.stepBtnOff]} hitSlop={4}>
            <Text style={styles.stepBtnText}>+</Text>
          </Pressable>
        </View>
      </View>
      <StreamStats />
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
  mode: "Look", // app start = Look: a stray first touch never clicks the PC
  bar: false,
  clickBtn: "left",
  crop: { x: 0, y: 0, w: 1, h: 1 },
  gameLock: false, // true while GAME owns the crop (Fit/restore transaction)
  fold: false, // Lipat: PAD/TYPE/WIN control area hidden, viewer takes the space
  win: null, // single-window stream: {id, title, exe, mon, x, y, w, h} or null
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
    fold: sel.fold,
    win: sel.win || null,
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
  // Tap: Perangkat screen (current PC, log out, recent PCs, connection log).
  return (
    <Pressable
      onPress={() => router.push("/devices")}
      hitSlop={8}
      style={({ pressed }) => [styles.connPill, pressed && styles.connPillPressed]}
      accessibilityLabel="Perangkat dan log koneksi"
    >
      <Text style={[styles.connDot, { color }]}>{glyph}</Text>
      <Text style={styles.connLabel} numberOfLines={1}>
        {st.pcName ? st.pcName.slice(0, 12) : "Perangkat"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: COLORS.card, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 6, gap: 4, marginHorizontal: 8, marginTop: 0, position: "relative" },
  presets: { flexDirection: "row", gap: 6, alignItems: "center" },
  dropBtn: { backgroundColor: "#5e5ce6", borderRadius: 8, height: 30, justifyContent: "center", paddingHorizontal: 10 },
  dropText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  stepper: { flex: 1, flexDirection: "row", backgroundColor: COLORS.chip, borderRadius: 8, height: 30, paddingHorizontal: 2, alignItems: "center", justifyContent: "space-between" },
  stepBtn: { borderRadius: 6, width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  stepBtnOff: { opacity: 0.3 },
  stepMid: { flex: 1, alignItems: "center", justifyContent: "center" },
  stepCaption: { color: COLORS.muted, fontWeight: "700", fontSize: 8, lineHeight: 10 },
  stepValue: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  stats: { color: COLORS.muted, fontSize: 11, fontWeight: "700", textAlign: "center" },
  statsWarn: { color: "#fbbf24" },
  modalShade: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  modalBox: { backgroundColor: COLORS.card, borderRadius: 14, padding: 8, gap: 4, minWidth: 200 },
  modalItem: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
  modalItemActive: { backgroundColor: "#5e5ce6" },
  modalText: { color: COLORS.muted, fontWeight: "800", fontSize: 14 },
  modalTextActive: { color: COLORS.text },
  wideBtn: { backgroundColor: COLORS.chip, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14 },
  wideText: { color: COLORS.text, fontWeight: "800", fontSize: 12 },
  lag: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(28,28,31,0.94)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,159,10,0.55)", paddingVertical: 6, paddingLeft: 10, paddingRight: 8 },
  lagText: { flex: 1, color: COLORS.text, fontSize: 12, fontWeight: "500" },
  lagBtn: { backgroundColor: COLORS.fill, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10 },
  lagBtnText: { color: "#ffffff", fontSize: 11, fontWeight: "700" },
  lagX: { color: COLORS.muted, fontSize: 14, fontWeight: "700" },
  connDot: { fontSize: 14, fontWeight: "800" },
  connPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: COLORS.chip, borderRadius: 999, height: 30, paddingHorizontal: 12, maxWidth: 140 },
  connPillPressed: { backgroundColor: "#5e5ce6" },
  connLabel: { color: COLORS.text, fontSize: 13, fontWeight: "800" },
});
