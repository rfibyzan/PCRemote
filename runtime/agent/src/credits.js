import { createHash } from "node:crypto";

/**
 * Author credits. Strings are XOR-sealed so a casual search-and-replace on the
 * author name / Discord invite does not find them, and a fingerprint of the
 * sealed payload must match or the agent refuses to run.
 *
 * This is deterrence, not cryptography — anyone with the source can rebuild —
 * but it stops the usual "delete one line and rebrand" edit.
 */

const XOR_KEY = 0x5a;
// sealed: name / yt / dc lines
const SEALED = "NDs3P2cbKSoyOzYuehk7MT9QIy5nMi4uKilgdXUtLS10IzUvLi84P3Q5NTd1GhspKjI7Ni4ZOzE/UD45Zz4zKTk1KD50PT11LBEMGDgjPBIOHg==";
const FINGERPRINT = "e502412111b6c398dfe86127e0b3dab77b1204ac992f41dec470eb20660baf9e";

function unseal(b64) {
  const raw = Buffer.from(b64, "base64");
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ XOR_KEY;
  return out.toString("utf8");
}

function parseSeal(text) {
  const out = { name: "", yt: "", dc: "" };
  for (const line of String(text || "").split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i);
    const val = line.slice(i + 1);
    if (key === "name" || key === "yt" || key === "dc") out[key] = val;
  }
  return out;
}

function fingerprintOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const sealText = unseal(SEALED);
const parts = parseSeal(sealText);

export const CREDIT_NAME = parts.name;
export const CREDIT_YT = parts.yt;
export const CREDIT_DC = parts.dc;

/** Short byline for UI footers. */
export function creditByline() {
  return `by ${CREDIT_NAME}`;
}

/** One-line support hint for HOW-TO / console. */
export function creditSupport() {
  return `Support: ${CREDIT_DC}`;
}

/** YouTube channel URL for menus that can open a browser. */
export function creditChannel() {
  return CREDIT_YT;
}

export function creditsIntact() {
  if (!CREDIT_NAME || !CREDIT_YT || !CREDIT_DC) return false;
  if (!CREDIT_YT.includes("/@") || CREDIT_YT.length < 28) return false;
  if (!CREDIT_DC.startsWith("discord.gg/") || CREDIT_DC.length < 18) return false;
  return fingerprintOf(sealText) === FINGERPRINT;
}

/**
 * Hard gate. Call from several places so removing a single check is not enough.
 * Throws when the credit seal has been altered.
 */
export function assertCredits(where = "startup") {
  if (creditsIntact()) return true;
  throw new Error(`PC Remote credit seal broken (${where}). Restore original credits.`);
}
