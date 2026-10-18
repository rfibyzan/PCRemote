/**
 * One shared viewer for PAD / TYPE / WIN. The viewer lives once in the tabs
 * layout (so the stream, decoder and camera never restart on a tab switch);
 * each tab screen only publishes what is specific to it: title, the PAD
 * touchpad/buttons, the control area under the toolbar, an overlay over the
 * stream and an optional tap hook. The viewer renders the active tab's slot.
 */
import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

const slots = new Map();
const listeners = new Set();

function emit() {
  for (const l of [...listeners]) l();
}

export function setSlot(name, cfg) {
  slots.set(name, cfg);
  emit();
}

export function clearSlot(name) {
  if (slots.delete(name)) emit();
}

export function getSlot(name) {
  return slots.get(name) || null;
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Viewer side: the slot of the active tab (null until it published). */
export function useSlot(name) {
  return useSyncExternalStore(subscribe, () => slots.get(name) || null);
}

/**
 * Tab side: publish this render's slot. Runs after every render of the tab so
 * the elements carry fresh state and closures; removed on unmount.
 */
export function useViewerSlot(name, cfg) {
  useLayoutEffect(() => {
    setSlot(name, cfg);
  });
  useEffect(() => () => clearSlot(name), [name]);
}
