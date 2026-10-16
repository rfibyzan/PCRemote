/**
 * Custom shortcut store (WIN > Pintasan): JSON file in the app's document
 * directory, mirrored to the PC agent through settingsync ("shortcuts").
 */
import { useEffect, useState } from "react";
import { File, Paths } from "expo-file-system";
import { cleanShortcuts } from "./shortcutmath";
import { registerSetting, settingChanged } from "./settingsync";

const FILE_NAME = "shortcuts-v1.json";
let list = null;
const listeners = new Set();

function file() {
  return new File(Paths.document, FILE_NAME);
}

function readFile() {
  try {
    const f = file();
    if (!f.exists) return null;
    return cleanShortcuts(JSON.parse(f.textSync() || "[]"));
  } catch {
    return null;
  }
}

function writeFile(next) {
  try {
    const f = file();
    if (!f.exists) f.create({ intermediates: true });
    f.write(JSON.stringify(next));
  } catch {
    // keep in memory; next save retries
  }
}

export function getShortcuts() {
  if (list == null) list = readFile() || [];
  return list;
}

function setLocal(next) {
  list = cleanShortcuts(next);
  writeFile(list);
  for (const l of [...listeners]) l(list);
  return list;
}

/** User edit: save, refresh the UI, send to the PC. */
export function saveShortcuts(next) {
  const clean = setLocal(next);
  settingChanged("shortcuts", clean);
}

export function useShortcuts() {
  const [s, setS] = useState(getShortcuts);
  useEffect(() => {
    listeners.add(setS);
    setS(getShortcuts());
    return () => listeners.delete(setS);
  }, []);
  return s;
}

registerSetting("shortcuts", {
  read: () => readFile(),
  apply: (v) => setLocal(v),
});
