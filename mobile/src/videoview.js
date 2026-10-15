/**
 * H.264 layer for the viewer canvas (beta). Lives inside the same camera
 * transform as the JPEG ScreenView, on top of it, filling the whole-monitor
 * canvas (the H.264 stream is always the full monitor; Look zoom just scales).
 *
 * The native view is mounted whenever the preference is on (so its Surface
 * is ready before the first keyframe), but stays invisible until the agent
 * confirmed video AND the decoder rendered a frame. Until then, and after
 * any fallback, the JPEG ScreenView underneath is what the user sees.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { VideoSurface, pushAU, resetDecoder, videoSupported } from "../modules/pcremote-video";
import { claimVideo, releaseVideo, useVideo, videoFailed } from "./video";

let nextStreamId = 1;

/**
 * Props:
 *  enabled   false for the Cam source (H.264 is screen only)
 *  onPacket  ({w, h, cx, cy, key, bytes}) per access unit: cursor, stall
 *            watchdog and byte meters in the viewer
 *  onActive  (bool) H.264 visible / JPEG back
 */
export default function VideoLayer({ enabled = true, onPacket, onActive }) {
  const v = useVideo();
  const idRef = useRef(0);
  if (!idRef.current) idRef.current = nextStreamId++;
  const onPacketRef = useRef(onPacket);
  onPacketRef.current = onPacket;
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const [rendered, setRendered] = useState(false);
  // Decoder errors since the last rendered frame; 3 in a row = give up.
  const errorsRef = useRef(0);
  const handlerRef = useRef(null);
  if (!handlerRef.current) {
    const t0 = Date.now();
    handlerRef.current = (pkt) => {
      if (!pkt?.data?.length) return;
      const ptsUs = (Date.now() - t0) * 1000;
      pushAU(idRef.current, pkt.data, ptsUs, pkt.key);
      try {
        onPacketRef.current?.({ w: pkt.w, h: pkt.h, cx: pkt.cx, cy: pkt.cy, key: pkt.key, bytes: pkt.data.length });
      } catch {
        // metadata consumers must not break decoding
      }
    };
  }

  // Only the focused viewer owns the stream (tabs stay mounted).
  const canUse = videoSupported && enabled;
  useFocusEffect(
    useCallback(() => {
      if (!canUse) return undefined;
      const h = handlerRef.current;
      claimVideo(h);
      return () => releaseVideo(h);
    }, [canUse]),
  );

  // Stream ended (fallback / toggle off / socket closed): fresh decoder next time.
  useEffect(() => {
    if (!v.active) {
      setRendered(false);
      resetDecoder(idRef.current);
    }
  }, [v.active]);

  const visible = canUse && v.pref && v.active && rendered;
  useEffect(() => {
    onActiveRef.current?.(visible);
  }, [visible]);

  const onVideoEvent = useCallback((e) => {
    const type = e?.nativeEvent?.type;
    if (type === "first") {
      errorsRef.current = 0;
      setRendered(true);
    } else if (type === "error") {
      setRendered(false);
      errorsRef.current += 1;
      if (errorsRef.current >= 3) {
        errorsRef.current = 0;
        videoFailed(`decoder HP gagal: ${String(e?.nativeEvent?.message || "").slice(0, 80)}`);
      }
    }
  }, []);

  if (!canUse || !v.pref) return null;
  return (
    <VideoSurface
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity: visible ? 1 : 0 }]}
      streamId={idRef.current}
      codecWidth={v.w || 1280}
      codecHeight={v.h || 720}
      onVideoEvent={onVideoEvent}
    />
  );
}
