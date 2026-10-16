/**
 * Settings sync with the PC agent (agent settings.js). Each synced setting
 * registers { read, apply }:
 *   read()      -> current local value (or null when never set)
 *   apply(v)    -> store a value that came from the PC and refresh the UI
 * User changes call settingChanged(key, value). Newest timestamp wins per key.
 * Pairing data (lock code, hosts, device id) is never synced.
 *
 * Local timestamps live in SecureStore "pcremote.syncts" ({ key: ms }).
 * A key with no local timestamp (fresh install, or first run after this
 * update) takes the PC's value when the PC has one, else pushes its own.
 */
import * as SecureStore from "expo-secure-store";
import { addListener, getStatus, send } from "./connection";
import { planSync } from "./settingsmath";

const STORE_TS = "pcremote.syncts";

const registry = new Map(); // key -> { read, apply }
let tsMap = {};
let tsLoaded = null;
let pendingRemote = null; // items received before a key registered

function loadTs() {
  if (!tsLoaded) {
    tsLoaded = SecureStore.getItemAsync(STORE_TS)
      .then((raw) => {
        const v = raw ? JSON.parse(raw) : null;
        if (v && typeof v === "object") tsMap = { ...v, ...tsMap };
      })
      .catch(() => {});
  }
  return tsLoaded;
}

function saveTs() {
  SecureStore.setItemAsync(STORE_TS, JSON.stringify(tsMap)).catch(() => {});
}

export function agentHasSettings() {
  const f = getStatus().hello?.features;
  return Array.isArray(f) && f.includes("settings");
}

function canSend() {
  try {
    return getStatus().connected && agentHasSettings();
  } catch {
    return false;
  }
}

/** Register a synced setting. Safe to call at module load. */
export function registerSetting(key, handlers) {
  registry.set(key, handlers);
  if (pendingRemote && pendingRemote[key]) {
    const one = { [key]: pendingRemote[key] };
    delete pendingRemote[key];
    reconcile(one, false);
  }
}

/** A user change: stamp it and send it to the PC when connected. */
export function settingChanged(key, value) {
  const ts = Date.now();
  tsMap[key] = ts;
  saveTs();
  if (canSend()) send({ t: "settings", set: { [key]: { v: value, ts } } });
}

async function reconcile(items, full) {
  await loadTs();
  const keys = [...registry.keys()];
  const locals = {};
  for (const k of keys) {
    if (tsMap[k]) continue;
    try {
      locals[k] = await registry.get(k).read();
    } catch {
      locals[k] = null;
    }
  }
  const plan = planSync({ keys, remote: items || {}, localTs: tsMap, localValues: locals, full, now: Date.now() });
  for (const [k, entry] of Object.entries(plan.apply)) {
    try {
      await registry.get(k).apply(entry.v);
      tsMap[k] = entry.ts;
    } catch {
      // a bad value from the PC must not break the others
    }
  }
  const push = {};
  for (const [k, entry] of Object.entries(plan.push)) {
    let v = entry.v;
    if (v === undefined) {
      try {
        v = await registry.get(k).read();
      } catch {
        v = null;
      }
    }
    if (v == null) continue;
    if (!tsMap[k]) tsMap[k] = entry.ts;
    push[k] = { v, ts: tsMap[k] };
  }
  saveTs();
  if (Object.keys(push).length && canSend()) send({ t: "settings", set: push });
  if (items) {
    for (const k of Object.keys(items)) {
      if (!registry.has(k)) {
        pendingRemote = pendingRemote || {};
        pendingRemote[k] = items[k];
      }
    }
  }
}

addListener((event) => {
  if (event.t === "hello") {
    if (Array.isArray(event.hello?.features) && event.hello.features.includes("settings")) {
      send({ t: "settings" });
    }
    return;
  }
  if (event.t === "settings" && event.items && typeof event.items === "object") {
    reconcile(event.items, Boolean(event.full));
  }
});

loadTs();
