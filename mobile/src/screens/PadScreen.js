/** PAD: Left/Hold/Mid/Right row + touchpad in the fixed control area of the
 * shared viewer (the viewer itself lives once in the tabs layout). */
import { useViewerSlot } from "../viewerslot";

export default function PadScreen() {
  useViewerSlot("Pad", { title: "Pad", touchpad: true, actions: true });
  return null;
}
