/** Pure helpers for winbar.js (tested in winbar.test.js). */
/** Short app name for a tile: exe without extension, else the title. */
export function tileName(w) {
  const exe = String(w?.exe || "").replace(/\.exe$/i, "");
  if (exe) return exe.charAt(0).toUpperCase() + exe.slice(1);
  return String(w?.title || "Jendela");
}

/** Keep thumbnails only for windows still listed (drop closed ones). */
export function pruneThumbs(thumbs, list) {
  const ids = new Set((list || []).map((w) => String(w.id)));
  const out = {};
  for (const [id, v] of Object.entries(thumbs || {})) if (ids.has(String(id))) out[id] = v;
  return out;
}

