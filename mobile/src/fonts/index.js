/**
 * UI font. `pcremote-local-fonts` is a Metro alias (metro.config.js): the
 * optional local font family when its files exist, else null.
 * familyFor() maps a fontWeight to the matching family once the files have
 * loaded (useAppFonts), or returns null = keep the system font.
 */
import { useEffect, useState } from "react";
import * as Font from "expo-font";
import local from "pcremote-local-fonts";
import { pickFamily } from "./pick";

let ready = false;

export function familyFor(weight) {
  return ready ? pickFamily(local, weight) : null;
}

/** true once fonts are usable (or there are none / they failed: system font). */
export function useAppFonts() {
  const [done, setDone] = useState(!local);
  useEffect(() => {
    if (!local) return;
    let alive = true;
    Font.loadAsync(local.files)
      .then(() => {
        ready = true;
      })
      .catch(() => {
        ready = false; // fall back to the system font
      })
      .finally(() => alive && setDone(true));
    return () => {
      alive = false;
    };
  }, []);
  return done;
}
