/**
 * Why displayed fps is below the target, from the PC's own counters
 * ({t:"streamStats"}) and the phone's receive/display meters. Pure, tested.
 * Order matters: a static screen explains everything else away.
 */
export function diagnoseStream({ target, shown, recv, pc }) {
  const t = Math.max(1, Number(target) || 1);
  if (shown >= t * 0.8) return "";
  if (pc) {
    if (pc.same >= Math.max(1, t * 0.3) && pc.sent < t * 0.8) return "layar statis";
    if (pc.busy >= 1) return "jaringan lambat";
    if (pc.capMs > 900 / t) return `PC lambat ${pc.capMs}ms`;
  }
  if (recv - shown >= 3) return "HP lambat decode";
  return "";
}
