import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } = naclUtil;

export const PORT = 18765;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const NTFY_PREFIX = "pcremote";
export const NTFY_HOSTS = ["https://ntfy.sh", "https://ntfy.adminforge.de", "https://ntfy.envs.net"];

export function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function generateCode() {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function roomId(code) {
  return createHash("sha256")
    .update(`pcremote-room:${normalizeCode(code)}`)
    .digest("hex")
    .slice(0, 20);
}

export function keyFromCode(code) {
  const digest = createHash("sha256")
    .update(`pcremote-v1:${normalizeCode(code)}`)
    .digest();
  return new Uint8Array(digest);
}

export function encryptJson(obj, key) {
  const nonce = nacl.randomBytes(24);
  const boxed = nacl.secretbox(decodeUTF8(JSON.stringify(obj)), nonce, key);
  return `${encodeBase64(nonce)}.${encodeBase64(boxed)}`;
}

export function decryptJson(payload, key) {
  try {
    const [nonceB64, boxB64] = String(payload).split(".");
    const opened = nacl.secretbox.open(decodeBase64(boxB64), decodeBase64(nonceB64), key);
    if (!opened) return null;
    return JSON.parse(encodeUTF8(opened));
  } catch {
    return null;
  }
}
