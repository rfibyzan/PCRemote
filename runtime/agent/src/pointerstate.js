/**
 * PC pointer presence (idea from Sill): which cursor shape Windows shows and
 * whether someone is using the PHYSICAL mouse at the PC. Pure, no koffi, so
 * unit_test.js can run it anywhere.
 *
 * "Local" = the cursor moved while the agent injected nothing recently.
 * Moves caused by the phone (SendInput) land within INJECT_GRACE_MS of an
 * injection and are ignored.
 */
export const INJECT_GRACE_MS = 350;
export const LOCAL_HOLD_MS = 2500;

export function createPresence() {
  return { x: null, y: null, localAt: 0 };
}

/** Feed one cursor sample; returns {local:boolean}. Mutates st. */
export function presenceStep(st, pos, now, lastInjectAt) {
  const moved = st.x !== null && (Math.abs(pos.x - st.x) > 1 || Math.abs(pos.y - st.y) > 1);
  st.x = pos.x;
  st.y = pos.y;
  if (moved && now - (lastInjectAt || 0) > INJECT_GRACE_MS) st.localAt = now;
  return { local: st.localAt > 0 && now - st.localAt < LOCAL_HOLD_MS };
}

/** Standard Windows cursor ids (IDC_*) -> short shape names the phone draws. */
export const CURSOR_IDS = {
  32512: "arrow",
  32513: "text",
  32514: "wait",
  32515: "cross",
  32516: "arrow", // up arrow
  32642: "nwse",
  32643: "nesw",
  32644: "ew",
  32645: "ns",
  32646: "move",
  32648: "no",
  32649: "hand",
  32650: "busy", // arrow + hourglass
  32651: "help",
};

/** Shape for a cursor handle, given {address -> name}. visible=false -> "none". */
export function shapeOf(visible, handle, table) {
  if (!visible) return "none";
  return (handle != null && table && table.get(String(handle))) || "arrow";
}
