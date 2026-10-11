/**
 * Per-tab screen orientation.
 *
 * Tabs stay mounted after their first visit, so mount/unmount effects are
 * NOT a reliable place to lock orientation: re-entering a tab would skip the
 * lock. Each tab applies its own lock every time it gains focus instead, and
 * never unlocks on blur (the next tab's focus decides, which avoids an
 * unlock racing the next lock).
 *
 *   GAME        -> landscape (either side)
 *   TYPE / WIN  -> portrait
 *   PAD         -> portrait (same fixed viewer size as TYPE / WIN)
 */
import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";

export const ORIENT = {
  landscape: ScreenOrientation.OrientationLock.LANDSCAPE,
  portrait: ScreenOrientation.OrientationLock.PORTRAIT_UP,
  free: null,
};

export function applyOrientation(mode) {
  const lock = ORIENT[mode];
  const p = lock === null || lock === undefined ? ScreenOrientation.unlockAsync() : ScreenOrientation.lockAsync(lock);
  return p.catch(() => {});
}

export function useTabOrientation(mode) {
  useFocusEffect(
    useCallback(() => {
      applyOrientation(mode);
    }, [mode]),
  );
}
