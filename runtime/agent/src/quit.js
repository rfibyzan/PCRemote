// POST /api/quit: lets PCRemote.exe (the launcher) ask a running agent to
// shut down cleanly instead of killing processes by port. Same guard as the
// other dashboard admin calls: this PC only (no LAN, no tunnel, no DNS
// rebinding) and the X-PCRemote header a cross-origin page cannot send.
import { isLocalRequest } from "./devices.js";

export const QUIT_PATH = "/api/quit";

export function quitAllowed(req) {
  if (!req || req.method !== "POST") return false;
  if (req.headers?.["x-pcremote"] !== "1") return false;
  return isLocalRequest(req);
}

/** Run the stop hooks (errors ignored), then exit(0) after a short delay so
 * the HTTP answer still reaches the launcher. Exit code 0 tells the launcher
 * (and start.bat) not to restart the agent. */
export function scheduleQuit({ stop = [], exit = (code) => process.exit(code), delayMs = 300, timer = setTimeout } = {}) {
  for (const fn of stop) {
    try {
      const r = fn?.();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      // keep shutting down
    }
  }
  return timer(() => exit(0), delayMs);
}
