/**
 * Load a JS module that needs native code, or null when this app build does
 * not have it (e.g. a dev client built before the module was added). The
 * feature then switches itself off instead of crashing the whole app with
 * "Cannot find native module ...".
 *
 *   const Clipboard = optionalModule(() => require("expo-clipboard"));
 */
export function optionalModule(load) {
  try {
    return load() || null;
  } catch {
    return null;
  }
}

/** Shown when a feature needs a newer app build. */
export const NEEDS_NEW_BUILD = "Fitur ini butuh versi app terbaru (build ulang / update APK).";
