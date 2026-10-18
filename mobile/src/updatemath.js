/** App update check (pure parts; src/updatecheck.js does the I/O).
 * Sources: GitHub's latest release (its PCRemote-<tag>.apk) and the PC
 * agent's hello.version. The phone only ever opens the download link; Android
 * installs the APK. */

export const RELEASES_API = "https://api.github.com/repos/rfibyzan/PCRemote/releases/latest";
export const RELEASES_PAGE = "https://github.com/rfibyzan/PCRemote/releases/latest";
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** -1 / 0 / 1 for "v1.2.0"-style versions; non-numeric parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Direct https link of the release's APK, or null. */
export function pickApk(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const a = assets.find((x) => /\.apk$/i.test(x?.name || "") && /^https:\/\//.test(x?.browser_download_url || ""));
  return a ? a.browser_download_url : null;
}

/** "v1.4.0" from a GitHub release that is newer than the app, else "". */
export function releaseTag(release) {
  if (!release?.tag_name || release.draft || release.prerelease) return "";
  return String(release.tag_name);
}

/**
 * What the banner shows, or null.
 * {tag, url, source: "github" | "pc"}: GitHub's APK when its release is
 * newer than the app; else, when only the PC says it runs a newer version
 * (GitHub unreachable), the releases page. A tag the user dismissed stays
 * hidden until a newer one appears.
 */
export function decideUpdate({ appVersion, release = null, pcVersion = "", dismissed = "" }) {
  if (!appVersion) return null;
  let best = null;
  const tag = releaseTag(release);
  if (tag && compareVersions(tag, appVersion) > 0) {
    best = { tag, url: pickApk(release) || String(release.html_url || RELEASES_PAGE), source: "github" };
  }
  if (pcVersion && compareVersions(pcVersion, appVersion) > 0 && (!best || compareVersions(pcVersion, best.tag) > 0)) {
    best = { tag: String(pcVersion), url: RELEASES_PAGE, source: "pc" };
  }
  if (!best) return null;
  if (dismissed && compareVersions(best.tag, dismissed) <= 0) return null;
  return best;
}
