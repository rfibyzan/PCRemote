/**
 * Automatic clipboard sync phone <-> PC (text). Agent side: clipsync.js.
 *
 * - On connect (hello) the phone asks the PC for sync: {t:"clipSync", on}.
 * - PC copy -> {t:"clipboard", s, auto:true} -> phone clipboard.
 * - Phone copy -> {t:"clipboard", s, auto:true} -> PC clipboard. Android only
 *   lets the app read the clipboard while it is in front, so the phone
 *   checks when something is copied inside the app (listener) and when the
 *   app comes back to the front (copy in Chrome, switch to PC Remote).
 * `last` = the text that was just synced, so nothing bounces back.
 * On by default; switch in WIN > Lainnya (also synced to the PC settings).
 */
import { AppState } from "react-native";
import { optionalModule } from "./optionalmodule";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { addListener, getStatus, send } from "./connection";

// Native module: missing in builds made before it was added -> sync off.
const Clipboard = optionalModule(() => require("expo-clipboard"));
const STORE = "pcremote.clipsync";
const MAX = 20000;
const st = { on: true, last: null, started: false };
const listeners = new Set();
let notice = null; // { at, dir: "in" | "out" } for the small viewer chip

function emitChange() {
  for (const l of [...listeners]) l();
}

function pushToPc(text) {
  const s = String(text || "").slice(0, MAX);
  if (!st.on || !s || s === st.last) return;
  if (!getStatus().connected) return;
  if (send({ t: "clipboard", s, auto: true })) {
    st.last = s;
    notice = { at: Date.now(), dir: "out" };
    emitChange();
  }
}

async function checkPhoneClipboard() {
  if (!Clipboard || !st.on || !getStatus().connected) return;
  try {
    if (!(await Clipboard.hasStringAsync())) return;
    pushToPc(await Clipboard.getStringAsync());
  } catch {
    // clipboard not readable right now (background / OS policy)
  }
}

/** Start once (app root). Safe to call again. */
export function startClipSync() {
  if (st.started || !Clipboard) return;
  st.started = true;
  SecureStore.getItemAsync(STORE)
    .then((v) => {
      if (v === "0") st.on = false;
      emitChange();
    })
    .catch(() => {});
  addListener((e) => {
    if (e.t === "hello") {
      st.last = null;
      send({ t: "clipSync", on: st.on });
      // Something copied on the phone while offline goes over now.
      if (st.on) void checkPhoneClipboard();
    } else if (e.t === "clipboard" && e.auto && st.on && typeof e.s === "string") {
      st.last = e.s;
      Clipboard.setStringAsync(e.s).catch(() => {});
      notice = { at: Date.now(), dir: "in" };
      emitChange();
    }
  });
  Clipboard.addClipboardListener(({ contentTypes }) => {
    if (contentTypes?.includes?.(Clipboard.ContentType.PLAIN_TEXT)) void checkPhoneClipboard();
  });
  AppState.addEventListener("change", (s) => {
    if (s === "active") setTimeout(() => void checkPhoneClipboard(), 400);
  });
}

export function setClipSync(on) {
  st.on = !!on;
  SecureStore.setItemAsync(STORE, on ? "1" : "0").catch(() => {});
  send({ t: "clipSync", on: st.on });
  emitChange();
}

/** { on, notice } - notice = last sync for ~2 s ({dir:"in"|"out"}) or null. */
export function useClipSync() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  const fresh = notice && Date.now() - notice.at < 2000 ? notice : null;
  useEffect(() => {
    if (!fresh) return undefined;
    const t = setTimeout(() => bump((n) => n + 1), 2000 - (Date.now() - fresh.at) + 20);
    return () => clearTimeout(t);
  }, [fresh]);
  return { on: st.on && !!Clipboard, available: !!Clipboard, notice: fresh };
}
