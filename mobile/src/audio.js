/**
 * PC sound on the phone ("Suara" in the viewer toolbar).
 *
 * On  = ask the agent for sound ({t:"audio", on:true}) and play the "PA"
 *       Opus packets natively (OpusPlayer.kt).
 * Off = tell the agent to stop: it stops capturing/encoding when no phone
 *       listens, so no data or battery is spent.
 * The choice is per phone (SecureStore), not synced to the PC. Needs an APK
 * with the native audio player and an agent with hello.features "audio".
 */
import React from "react";
import * as SecureStore from "expo-secure-store";
import { audioPush, audioStart, audioStop, audioSupported } from "../modules/pcremote-video";
import { addListener, connLog, getStatus, send, setAudioHandler } from "./connection";
import { agentHasAudio } from "./audioproto";

export const STORE_AUDIO = "pcremote.audio";

const st = {
  on: false,
  loaded: false,
  agent: false, // connected agent supports audio
  playing: false, // agent confirmed capture is running
  error: "",
};
const subs = new Set();

function snapshot() {
  return { on: st.on, supported: audioSupported, agent: st.agent, playing: st.playing, error: st.error };
}

function emit() {
  const s = snapshot();
  for (const fn of [...subs]) {
    try {
      fn(s);
    } catch {
      // ignore
    }
  }
}

function onPacket(p) {
  audioPush(p.data);
}

/** Apply the wanted state to the agent + native player (idempotent). */
function apply() {
  const want = st.on && audioSupported && st.agent;
  if (want) {
    audioStart();
    setAudioHandler(onPacket);
    send({ t: "audio", on: true });
  } else {
    setAudioHandler(null);
    audioStop();
    if (st.agent) send({ t: "audio", on: false });
    st.playing = false;
  }
  emit();
}

async function loadOnce() {
  if (st.loaded) return;
  st.loaded = true;
  try {
    st.on = (await SecureStore.getItemAsync(STORE_AUDIO)) === "1";
  } catch {
    st.on = false;
  }
  try {
    st.agent = agentHasAudio(getStatus().hello);
  } catch {
    st.agent = false;
  }
  if (st.on && st.agent) apply();
  else emit();
}
loadOnce();

addListener((event) => {
  if (event.t === "hello") {
    st.agent = agentHasAudio(event.hello);
    st.playing = false;
    st.error = "";
    // Fresh socket (reconnect, LAN handover): ask again.
    if (st.on) apply();
    else emit();
    return;
  }
  if (event.t === "close") {
    setAudioHandler(null);
    audioStop();
    st.playing = false;
    emit();
    return;
  }
  if (event.t === "audio") {
    const wasPlaying = st.playing;
    st.playing = Boolean(event.running && event.on);
    const err = event.error ? String(event.error) : "";
    if (err && err !== st.error) connLog.add(`Suara PC: ${err}`, "warn");
    else if (st.playing && !wasPlaying) connLog.add("Suara PC: diputar di HP", "ok");
    st.error = err;
    emit();
  }
});

export async function setAudioOn(on) {
  st.on = Boolean(on);
  st.error = "";
  try {
    await SecureStore.setItemAsync(STORE_AUDIO, st.on ? "1" : "0");
  } catch {
    // best-effort
  }
  apply();
}

export function getAudio() {
  return snapshot();
}

export function useAudio() {
  const [s, setS] = React.useState(snapshot());
  React.useEffect(() => {
    subs.add(setS);
    setS(snapshot());
    return () => subs.delete(setS);
  }, []);
  return s;
}
