// Pure helpers for the app launcher (testable off Windows).
const JUNK_NAME = /\b(uninstall|uninstaller|hapus instal|readme|read me|help|documentation|release notes|website|license|changelog)\b/i;
const JUNK_TARGET = /\.(url|html?|chm|txt|pdf|md|rtf|ini|log)$/i;

// Raw rows from the PowerShell scan -> clean, deduped, A-Z list.
export function cleanApps(rows) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) {
    const id = String(r?.id || "").trim();
    const name = String(r?.name || "").trim();
    const target = String(r?.target || "").trim();
    if (!id || !name || JUNK_NAME.test(name) || JUNK_TARGET.test(target) || /^https?:/i.test(target)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name, icon: r.icon || null, admin: /\.exe$/i.test(target), target: target || null });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

// What goes over the wire (no target paths).
export function appsForPhone(list) {
  return list.map(({ id, name, icon, admin }) => ({ id, name, icon, admin }));
}
