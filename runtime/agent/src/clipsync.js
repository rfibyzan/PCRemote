/**
 * Automatic clipboard sync PC <-> phones (text only).
 *
 * PC -> phone: every POLL_MS the Windows clipboard sequence number is read
 * (GetClipboardSequenceNumber: one cheap user32 call, no PowerShell). Only
 * when it changes is the text read and pushed as {t:"clipboard", s, auto:true}
 * to the phones that turned sync on ({t:"clipSync", on:true}). Nothing runs
 * while no phone wants sync.
 * Phone -> PC: {t:"clipboard", s, auto:true} sets the PC clipboard and goes
 * to the other syncing phones. `last` remembers the text that was just
 * synced so it never bounces back to where it came from.
 */
export const CLIP_POLL_MS = 800;
export const CLIP_MAX = 20000;

/** Text as the phones get it: PowerShell's trailing newline off, capped. */
export function normClip(s) {
  return String(s ?? "")
    .replace(/\r?\n$/, "")
    .slice(0, CLIP_MAX);
}

/** Should this clipboard text be pushed? (non-empty and not an echo). */
export function shouldPush(text, last) {
  return text.length > 0 && text !== last;
}

export function createClipSync({ clients, send, readSeq, readText, writeText, log = () => {} }) {
  let timer = null;
  let seq = null;
  let last = null;
  let busy = false;

  const syncing = () => [...clients()].filter((ws) => ws.clipSync);

  async function poll() {
    if (busy) return;
    const s = readSeq();
    if (s === seq) return;
    seq = s;
    busy = true;
    try {
      const text = normClip(await readText());
      if (!shouldPush(text, last)) return;
      last = text;
      for (const ws of syncing()) send(ws, { t: "clipboard", s: text, auto: true });
    } catch (err) {
      log(`clipboard sync: ${err?.message || err}`);
    } finally {
      busy = false;
    }
  }

  function update() {
    const want = syncing().length > 0;
    if (want && !timer) {
      seq = readSeq(); // only changes from now on, never an old clipboard
      timer = setInterval(() => void poll(), CLIP_POLL_MS);
      timer.unref?.();
    } else if (!want && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    /** {t:"clipSync", on} from a phone. */
    setWanted(ws, on) {
      ws.clipSync = !!on;
      update();
    },
    /** {t:"clipboard", s, auto:true} from a phone. */
    async fromPhone(ws, s) {
      const text = normClip(s);
      if (!text || text === last) return;
      last = text;
      await writeText(text);
      seq = readSeq(); // our own write is not a new PC copy
      for (const other of syncing()) if (other !== ws) send(other, { t: "clipboard", s: text, auto: true });
    },
    /** A phone left. */
    drop(ws) {
      ws.clipSync = false;
      update();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
