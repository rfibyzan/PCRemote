/**
 * Pure planning for "real key" typing: turn one character into the key
 * presses a physical keyboard would make on the PC's current layout, so games
 * and global hotkeys (Roblox "/" chat, launchers) see real key events instead
 * of VK_PACKET Unicode, which only text fields accept.
 *
 * scanResult is VkKeyScanW(ch): low byte = VK, high byte = shift state
 * (1 Shift, 2 Ctrl, 4 Alt), -1 / 0xFFFF = not on this layout.
 * Returns { vk, shift } or null (caller falls back to Unicode).
 */
export function planChar(ch, scanResult, capsOn = false) {
  const r = Number(scanResult);
  if (!Number.isFinite(r) || r < 0 || (r & 0xffff) === 0xffff) return null;
  const vk = r & 0xff;
  const state = (r >> 8) & 0xff;
  if (!vk || vk === 0xff) return null;
  // AltGr / Ctrl characters (e.g. € on many EU layouts) are layout tricks a
  // game rarely needs; Unicode is safer for them.
  if (state & 0x06) return null;
  let shift = Boolean(state & 0x01);
  // Caps Lock flips letters only; send the Shift state that yields `ch`.
  const isLetter = vk >= 0x41 && vk <= 0x5a && ch.toLowerCase() !== ch.toUpperCase();
  if (isLetter && capsOn) shift = !shift;
  return { vk, shift };
}

/** Characters always sent as Unicode (control chars except newline/tab). */
export function forceUnicode(ch) {
  const c = ch.codePointAt(0) || 0;
  return c > 0xffff || (c < 0x20 && ch !== "\n" && ch !== "\t");
}
