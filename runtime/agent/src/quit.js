// POST /api/quit: lets PCRemote.exe (the launcher) ask a running agent to
// shut down cleanly instead of killing processes by port. Same guard as the
// other dashboard admin calls: this PC only (no LAN, no tunnel, no DNS
// rebinding) and the X-PCRemote header a cross-origin page cannot send.
import { isLocalRequest } from "./devices.js";

export const QUIT_PATH = "/api/quit";
// POST /api/restart: same guard. The agent exits with RESTART_CODE and its
// supervisor (PCRemote.exe or start.bat) starts it again a moment later, so
// the user never has to reopen PC Remote by hand (e.g. while remoting in).
export const RESTART_PATH = "/api/restart";
export const RESTART_CODE = 75;

/** Only a supervised agent can restart; a bare `node src/index.js` would
 * just exit and stay gone. */
export function restartSupported(env = process.env) {
  return env.PCREMOTE_LAUNCHER === "1" || env.PCREMOTE_SUPERVISED === "1";
}

export function quitAllowed(req) {
  if (!req || req.method !== "POST") return false;
  if (req.headers?.["x-pcremote"] !== "1") return false;
  return isLocalRequest(req);
}

/** Run the stop hooks (errors ignored), then exit(code) after a short delay
 * so the HTTP answer still reaches the launcher. Exit code 0 tells the
 * launcher (and start.bat) not to restart the agent; RESTART_CODE asks it
 * to start the agent again right away. */
export function scheduleQuit({ stop = [], exit = (code) => process.exit(code), delayMs = 300, timer = setTimeout, code = 0 } = {}) {
  for (const fn of stop) {
    try {
      const r = fn?.();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      // keep shutting down
    }
  }
  return timer(() => exit(code), delayMs);
}
