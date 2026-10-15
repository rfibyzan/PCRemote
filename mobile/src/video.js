/**
 * H.264 screen stream, ON by default; JPEG is the fallback.
 *
 * Preference "Video H.264" (default on; a saved choice wins) is persisted in SecureStore
 * (pcremote.video). The focused viewer owns the stream the same way it owns
 * JPEG frames: claimVideo(handler) on focus, releaseVideo(handler) on blur
 * (ownership-guarded, so tab B focusing before tab A blurs never turns B's
 * video off). The agent answers {t:"video"} with {t:"videoState"}; until it
 * says on:true (first access unit produced) the phone keeps showing JPEG, and
 * any on:false (ffmpeg missing, encoder crash, ...) falls back to JPEG.
 */
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import Text from "./AppText";
import { COLORS } from "./components";
import { msg } from "./protocol";
import { addListener, getStatus, releaseVideoHandler, send, setVideoHandler } from "./connection";
import { addQualityListener, getQuality } from "./controls";
import { fmtKbps, videoParams } from "./videoproto";
import { videoSupported } from "../modules/pcremote-video";

export const STORE_VIDEO = "pcremote.video";

const vs = {
  pref: true, // H.264 by default; JPEG only as fallback or when switched off
  loaded: false,
  active: false, // agent confirmed: H.264 is flowing, JPEG paused
  encoder: "",
  w: 0,
  h: 0,
  reason: "", // last failure from the agent (shown under the toggle)
  sentOn: false,
  owner: null,
  blocked: false, // this phone's decoder failed: stay on JPEG until toggled / reconnected
};
const vsListeners = new Set();

function snapshot() {
  return { pref: vs.pref, active: vs.active, encoder: vs.encoder, w: vs.w, h: vs.h, reason: vs.reason, supported: videoSupported };
}

function emitVs() {
  const s = snapshot();
  for (const fn of [...vsListeners]) {
    try {
      fn(s);
    } catch {
      // one bad subscriber must not break the rest
    }
  }
}

function currentParams() {
  let link = "";
  try {
    link = getStatus().link || "";
  } catch {
    link = "";
  }
  return videoParams(getQuality(), link);
}

/** Tell the agent what we want right now (idempotent). */
function syncAgent(force = false) {
  const want = Boolean(vs.pref && videoSupported && vs.owner && !vs.blocked);
  if (want) {
    send(msg.video(true, currentParams()));
    vs.sentOn = true;
  } else if (vs.sentOn || force) {
    send(msg.video(false));
    vs.sentOn = false;
  }
}

function loadOnce() {
  if (vs.loaded) return;
  vs.loaded = true;
  SecureStore.getItemAsync(STORE_VIDEO)
    .then((raw) => {
      const saved = JSON.parse(raw || "null");
      if (saved && typeof saved.on === "boolean" && saved.on !== vs.pref) {
        vs.pref = saved.on;
        emitVs();
        syncAgent();
      }
    })
    .catch(() => {});
}
loadOnce();

export function isVideoActive() {
  return vs.active;
}

/** The phone could not decode the stream: back to JPEG for this session. */
export function videoFailed(reason) {
  vs.blocked = true;
  vs.active = false;
  vs.reason = String(reason || "decoder HP gagal");
  syncAgent(true);
  emitVs();
}

export function setVideoPref(on) {
  vs.pref = Boolean(on);
  vs.blocked = false;
  vs.reason = "";
  SecureStore.setItemAsync(STORE_VIDEO, JSON.stringify({ on: vs.pref })).catch(() => {});
  emitVs();
  syncAgent();
}

/** Focused viewer takes the H.264 stream (and its AU handler). */
export function claimVideo(handler) {
  vs.owner = handler;
  setVideoHandler(handler);
  syncAgent();
}

export function releaseVideo(handler) {
  if (!handler || vs.owner !== handler) return;
  vs.owner = null;
  releaseVideoHandler(handler);
  syncAgent();
  if (vs.active) {
    vs.active = false;
    emitVs();
  }
}

addListener((event) => {
  if (event.t === "videoState") {
    const on = Boolean(event.on);
    vs.active = on && vs.pref;
    if (on) {
      vs.encoder = String(event.encoder || "");
      vs.w = Number(event.w) || 0;
      vs.h = Number(event.h) || 0;
      vs.reason = "";
    } else if (event.reason) {
      vs.reason = String(event.reason);
      vs.sentOn = false; // the agent gave up; next claim / quality change retries
    }
    emitVs();
    return;
  }
  if (event.t === "hello") {
    // Fresh socket: nothing is streaming yet; re-ask if a viewer is focused.
    vs.active = false;
    vs.blocked = false;
    vs.sentOn = false;
    emitVs();
    syncAgent();
    return;
  }
  if (event.t === "close") {
    vs.active = false;
    vs.sentOn = false;
    emitVs();
  }
});

// Quality preset / Q / fps / link changes re-tune the encoder (agent restarts
// ffmpeg only when the numbers actually change).
let lastParamsKey = "";
addQualityListener(() => {
  if (!vs.pref || !vs.owner) return;
  const key = JSON.stringify(currentParams());
  if (key === lastParamsKey && vs.sentOn) return;
  lastParamsKey = key;
  syncAgent();
});

export function useVideo() {
  const [s, setS] = useState(snapshot);
  useEffect(() => {
    loadOnce();
    const fn = (n) => setS(n);
    vsListeners.add(fn);
    setS(snapshot());
    return () => vsListeners.delete(fn);
  }, []);
  return s;
}

/** "Video H.264" switch for the stream ⚙ popover. */
export function VideoToggle() {
  const v = useVideo();
  const p = currentParams();
  let note;
  if (!v.supported) note = "Perlu build baru aplikasi (modul video belum ada di APK ini).";
  else if (!v.pref) note = "Mati: pakai JPEG.";
  else if (v.active) note = `Aktif · ${v.encoder || "h264"} ${v.w}×${v.h} · ${fmtKbps(p.kbps)} · ${p.fps} fps`;
  else if (v.reason) note = `Kembali ke JPEG: ${v.reason}`;
  else note = `Menyalakan… (${fmtKbps(p.kbps)} · ${p.fps} fps)`;
  return (
    <View style={styles.set}>
      <View style={styles.row}>
        <Text style={styles.label}>Video H.264</Text>
        <View style={styles.seg}>
          {[
            ["Mati", false],
            ["Nyala", true],
          ].map(([label, on]) => {
            const sel = v.pref === on;
            return (
              <Pressable
                key={label}
                disabled={!v.supported && on}
                onPress={() => setVideoPref(on)}
                style={[styles.segBtn, sel && styles.segOn, !v.supported && on && styles.segDisabled]}
                hitSlop={3}
              >
                <Text style={[styles.segText, sel && styles.segTextOn]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <Text style={[styles.note, !!v.reason && v.pref && !v.active && styles.noteWarn]} numberOfLines={2}>
        {note}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  set: { marginTop: 6, backgroundColor: COLORS.card, borderRadius: 12, padding: 10, gap: 6, borderWidth: 1, borderColor: COLORS.line },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { color: COLORS.text, fontSize: 12, fontWeight: "800", flex: 1 },
  seg: { width: 140, flexDirection: "row", backgroundColor: COLORS.chip, borderRadius: 10, padding: 2 },
  segBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: "center" },
  segOn: { backgroundColor: COLORS.fill },
  segDisabled: { opacity: 0.4 },
  segText: { color: COLORS.muted, fontSize: 12, fontWeight: "800" },
  segTextOn: { color: COLORS.text },
  note: { color: COLORS.muted, fontSize: 10 },
  noteWarn: { color: "#fbbf24" },
});
