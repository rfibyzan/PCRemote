/**
 * Update check against GitHub Releases (idea from Sill). A release zip built by
 * .github/workflows/release.yml carries runtime/agent/version.txt ("v1.3.0");
 * a git checkout has none and never checks (update with git pull there).
 * The dashboard shows a banner with "Perbarui sekarang" (src/updater.js
 * downloads, swaps the files and restarts) when a newer release exists.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASES_API = "https://api.github.com/repos/rfibyzan/PCRemote/releases/latest";
export const RELEASES_PAGE = "https://github.com/rfibyzan/PCRemote/releases/latest";
/** Release builds re-check this often (and on "Cek sekarang"). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));

/** "v1.3.0" from version.txt next to package.json, or "" for a dev checkout. */
export function agentVersion() {
  try {
    return readFileSync(path.join(here, "..", "version.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

/** -1 / 0 / 1 for "v1.2.0"-style tags; non-numeric parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The zip the one-click update downloads: the small PCRemote-<tag>-update.zip
 * (PCRemote.exe + runtime/agent) when the release has it, else the full
 * PCRemote-<tag>-windows.zip (older releases). null when neither exists.
 */
export function pickUpdateAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const ok = (a) => a && typeof a.browser_download_url === "string" && /^https:\/\//.test(a.browser_download_url);
  const small = assets.find((a) => ok(a) && /-update\.zip$/i.test(a.name || ""));
  const full = assets.find((a) => ok(a) && /-windows\.zip$/i.test(a.name || ""));
  const a = small || full;
  return a ? { name: String(a.name), url: a.browser_download_url, size: Number(a.size) || 0, full: !small } : null;
}

/** {tag, url, asset} when GitHub's latest release is newer than `current`, else null. */
export function newerRelease(current, latest) {
  if (!current || !latest?.tag_name || latest.draft || latest.prerelease) return null;
  if (compareVersions(latest.tag_name, current) <= 0) return null;
  return {
    tag: String(latest.tag_name),
    url: String(latest.html_url || RELEASES_PAGE),
    asset: pickUpdateAsset(latest),
  };
}

/** Best-effort network check (8 s timeout). Never throws.
 * {ok:true, update|null} or {ok:false, error}. */
export async function checkForUpdate(current = agentVersion(), fetchImpl = fetch) {
  if (!current) return { ok: false, error: "dev" };
  try {
    const res = await fetchImpl(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pcremote-agent" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}` };
    return { ok: true, update: newerRelease(current, await res.json()) };
  } catch (err) {
    return { ok: false, error: err?.name === "TimeoutError" ? "Tidak ada respons dari GitHub" : "Tidak bisa menghubungi GitHub" };
  }
}
