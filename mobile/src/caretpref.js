/**
 * "Zoom ikut teks" settings for live typing (caretmath.js / viewer.js):
 *   follow  - camera follows the PC caret while typing (default on)
 *   textPx  - how big text should look on the phone (set by pinching)
 * Stored locally and synced with the PC like the other settings.
 */
import { useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { registerSetting, settingChanged } from "./settingsync";
import { TEXT_PX_DEFAULT, TEXT_PX_MAX, TEXT_PX_MIN } from "./caretmath";

const STORE = "pcremote.caretzoom";
const pref = { follow: true, textPx: TEXT_PX_DEFAULT };
const listeners = new Set();

function notify() {
  for (const l of [...listeners]) l();
}
function take(v) {
  if (!v || typeof v !== "object") return;
  if (typeof v.follow === "boolean") pref.follow = v.follow;
  if (Number.isFinite(v.textPx)) pref.textPx = Math.min(TEXT_PX_MAX, Math.max(TEXT_PX_MIN, v.textPx));
}
function store() {
  SecureStore.setItemAsync(STORE, JSON.stringify(pref)).catch(() => {});
}
function save() {
  store();
  settingChanged("caretZoom", { ...pref });
  notify();
}

SecureStore.getItemAsync(STORE)
  .then((raw) => {
    if (raw) take(JSON.parse(raw));
    notify();
  })
  .catch(() => {});

registerSetting("caretZoom", {
  read: async () => {
    const raw = await SecureStore.getItemAsync(STORE);
    return raw ? JSON.parse(raw) : null;
  },
  apply: (v) => {
    take(v);
    store();
    notify();
  },
});

export function getCaretPref() {
  return { ...pref };
}
export function setCaretFollow(on) {
  pref.follow = !!on;
  save();
}
export function setCaretTextPx(px) {
  if (!Number.isFinite(px)) return;
  take({ textPx: Math.round(px) });
  save();
}
export function onCaretPref(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function useCaretPref() {
  const [v, setV] = useState(getCaretPref);
  useEffect(() => onCaretPref(() => setV(getCaretPref())), []);
  return v;
}
