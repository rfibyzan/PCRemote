/**
 * Local Expo module "PcremoteVideo" (Android only): H.264 Annex-B access
 * units -> MediaCodec -> TextureView. Every entry point is guarded, so a
 * build without the native module (older preview APK, Expo Go, iOS, web)
 * just reports videoSupported = false and never crashes.
 */
import React from "react";
import { Platform } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";

let Native = null;
let NativeView = null;
if (Platform.OS === "android") {
  try {
    Native = requireOptionalNativeModule("PcremoteVideo");
    if (Native) NativeView = requireNativeView("PcremoteVideo");
  } catch {
    Native = null;
    NativeView = null;
  }
}

export const videoSupported = Boolean(Native && NativeView);

/** Queue one access unit (Uint8Array, Annex-B) for the view with this streamId. */
export function pushAU(streamId, bytes, ptsUs, key) {
  if (!Native) return false;
  try {
    return Boolean(Native.push(streamId, bytes, ptsUs, Boolean(key)));
  } catch {
    return false;
  }
}

export function resetDecoder(streamId) {
  if (!Native) return;
  try {
    Native.reset(streamId);
  } catch {
    // best-effort
  }
}

/** Native decoder surface. Props: streamId (number), codecWidth/codecHeight
 * (size hint), onVideoEvent({nativeEvent:{type,...}}), style. */
export function VideoSurface(props) {
  if (!NativeView) return null;
  return <NativeView {...props} />;
}
