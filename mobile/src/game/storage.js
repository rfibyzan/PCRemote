/**
 * Persist the GAME layout as JSON in the app's document directory.
 * (SecureStore is for secrets and has a small value-size budget; a layout is
 * neither.) Failures fall back to defaults and never throw into the UI.
 */
import { File, Paths } from "expo-file-system";
import { cleanLayout, defaultLayout } from "./layout";
import { registerSetting, settingChanged } from "../settingsync";

const FILE_NAME = "gamepad-layout-v2.json";

function file() {
  return new File(Paths.document, FILE_NAME);
}

export function loadLayout() {
  try {
    const f = file();
    if (!f.exists) return defaultLayout();
    return cleanLayout(JSON.parse(f.textSync() || "null"));
  } catch {
    return defaultLayout();
  }
}

function writeLayout(layout) {
  try {
    const f = file();
    if (!f.exists) f.create({ intermediates: true });
    f.write(JSON.stringify(cleanLayout(layout)));
    return true;
  } catch {
    return false;
  }
}

/** User edit: save and mirror to the PC agent (settingsync "gameLayout"). */
export function saveLayout(layout) {
  const ok = writeLayout(layout);
  settingChanged("gameLayout", cleanLayout(layout));
  return ok;
}

const restoreListeners = new Set();
/** GameScreen hears a layout restored from the PC. Returns unsubscribe. */
export function onLayoutRestored(fn) {
  restoreListeners.add(fn);
  return () => restoreListeners.delete(fn);
}

registerSetting("gameLayout", {
  read: () => {
    try {
      const f = file();
      return f.exists ? JSON.parse(f.textSync() || "null") : null;
    } catch {
      return null;
    }
  },
  apply: (v) => {
    if (!v) return;
    const layout = cleanLayout(v);
    writeLayout(layout);
    for (const l of [...restoreListeners]) l(layout);
  },
});
