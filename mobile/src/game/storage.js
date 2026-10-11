/**
 * Persist the GAME layout as JSON in the app's document directory.
 * (SecureStore is for secrets and has a small value-size budget; a layout is
 * neither.) Failures fall back to defaults and never throw into the UI.
 */
import { File, Paths } from "expo-file-system";
import { cleanLayout, defaultLayout } from "./layout";

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

export function saveLayout(layout) {
  try {
    const f = file();
    if (!f.exists) f.create({ intermediates: true });
    f.write(JSON.stringify(cleanLayout(layout)));
    return true;
  } catch {
    return false;
  }
}
