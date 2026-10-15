/**
 * Update check against GitHub Releases (idea from Sill). A release zip built by
 * .github/workflows/release.yml carries runtime/agent/version.txt ("v1.2.0");
 * a git checkout has none and never checks. The PC dashboard shows a banner
 * with the download link when a newer release exists. Nothing auto-installs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASES_API = "https://api.github.com/repos/rfibyzan/PCRemote/releases/latest";

const here = path.dirname(fileURLToPath(import.meta.url));

/** "v1.2.0" from version.txt next to package.json, or "" for a dev checkout. */
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

/** {tag, url} when GitHub's latest release is newer than `current`, else null. */
export function newerRelease(current, latest) {
  if (!current || !latest?.tag_name || latest.draft || latest.prerelease) return null;
  if (compareVersions(latest.tag_name, current) <= 0) return null;
  return { tag: String(latest.tag_name), url: String(latest.html_url || "https://github.com/rfibyzan/PCRemote/releases/latest") };
}

/** Best-effort network check (6 s timeout). Never throws. */
export async function checkForUpdate(current = agentVersion()) {
  if (!current) return null;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pcremote-agent" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return newerRelease(current, await res.json());
  } catch {
    return null;
  }
}
