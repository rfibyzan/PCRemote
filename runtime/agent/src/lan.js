import os from "node:os";

export function isLanIPv4(entry) {
  const v4 = entry?.family === "IPv4" || entry?.family === 4;
  if (!v4 || entry.internal) return false;
  const addr = String(entry.address || "");
  if (!addr || addr.startsWith("169.254.")) return false;
  return true;
}

export function lanAddresses(nets = os.networkInterfaces()) {
  const out = [];
  for (const entries of Object.values(nets || {})) {
    for (const entry of entries || []) {
      if (isLanIPv4(entry)) out.push(entry.address);
    }
  }
  return out;
}
