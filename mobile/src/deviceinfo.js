/** Who this phone is, sent with auth so the PC dashboard can list it and
 * disconnect it. The id is random, made once and kept in SecureStore. */
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Platform } from "react-native";

const STORE_DEVICE_ID = "pcremote.deviceId";
let cached = null;

function randomId() {
  try {
    const Crypto = require("expo-crypto");
    if (Crypto?.randomUUID) return Crypto.randomUUID();
  } catch {
    // fall through
  }
  let s = "";
  for (let i = 0; i < 32; i += 1) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export async function getDeviceInfo() {
  if (cached) return cached;
  let id = "";
  try {
    id = (await SecureStore.getItemAsync(STORE_DEVICE_ID)) || "";
  } catch {
    id = "";
  }
  if (!id) {
    id = randomId();
    try {
      await SecureStore.setItemAsync(STORE_DEVICE_ID, id);
    } catch {
      // a new id next launch is harmless
    }
  }
  const c = Platform.constants || {};
  const brand = String(c.Brand || c.Manufacturer || "").trim();
  const model = String(c.Model || "").trim();
  const cap = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "";
  const name = [cap, model].filter(Boolean).join(" ") || (Platform.OS === "ios" ? "iPhone" : "Android phone");
  const osv = Platform.OS === "android" ? `Android ${c.Release || Platform.Version}` : `${Platform.OS} ${Platform.Version}`;
  cached = {
    id,
    name: name.slice(0, 60),
    model: model.slice(0, 60),
    os: osv,
    app: String(Constants?.expoConfig?.version || ""),
  };
  return cached;
}
