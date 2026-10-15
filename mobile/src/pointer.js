/**
 * PC pointer presence (idea from Sill). The agent sends {t:"ptr", shape,
 * local}: the Windows cursor shape and whether someone is moving the PC's
 * physical mouse. The ring on the stream shows the shape as an icon (plain
 * arrow keeps the bare ring), turns orange while the PC mouse is in use, and
 * goes dashed when the cursor is hidden (games, video). Pure, tested.
 */
const ICONS = {
  text: "cursor-text",
  hand: "cursor-pointer",
  wait: "timer-sand",
  busy: "progress-clock",
  cross: "plus",
  move: "arrow-all",
  ew: "arrow-left-right",
  ns: "arrow-up-down",
  nwse: "arrow-top-left-bottom-right",
  nesw: "arrow-top-right-bottom-left",
  no: "cancel",
  help: "help-circle-outline",
};

/** MaterialCommunityIcons name for a shape, or "" for arrow/none/unknown. */
export function pointerIcon(shape) {
  return ICONS[shape] || "";
}
