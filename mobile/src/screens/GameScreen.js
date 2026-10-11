/**
 * GAME: fullscreen landscape virtual Xbox controller over the PC screen.
 *
 * - Overlay: data-driven Xbox layout (src/game/layout.js), every control
 *   movable / resizable / fadable / hideable, saved on the phone.
 * - Multi-touch: one router tracks every finger by pointer id from first
 *   contact (src/game/router.js) — both sticks, ABXY, triggers, bumpers at once.
 * - Protocol (unchanged): {t:"gamepad",state} at ~30 Hz when dirty, buttons and
 *   triggers flushed immediately, 500 ms heartbeat (agent WATCHDOG_MS = 2 s),
 *   zero-state + gamepadEnd on exit. Stream crop is forced to Fit while in GAME
 *   and the previous tab crop is restored on exit.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as ScreenOrientation from "expo-screen-orientation";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { ScreenView } from "../components";
import { StreamControls, setSel } from "../controls";
import { useCursor } from "../cursor";
import { getCommittedCrop, setCommittedCrop } from "../viewer";
import { msg } from "../protocol";
import { addListener, getStatus, send } from "../connection";
import { GamepadState } from "../game/GamepadState";
import GamepadOverlay from "../game/GamepadOverlay";
import { EditToolbar, GameChrome, SettingsSheet } from "../game/GameMenus";
import { LIMITS, controlOpacity, defaultLayout, patchControl, stepValue } from "../game/layout";
import { loadLayout, saveLayout } from "../game/storage";

const HEARTBEAT_MS = 500;
const TICK_MS = 33;

export default function GameScreen({ onExit }) {
  const pad = useMemo(() => new GamepadState(), []);
  const exitRef = useRef(false);
  const cursor = useCursor();

  // ---- layout state ----
  const [layout, setLayout] = useState(() => loadLayout());
  const savedRef = useRef(layout); // last persisted layout (edit "Batal" target)
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const commitLayout = useCallback((next) => {
    setLayout(next);
    savedRef.current = next;
    saveLayout(next);
  }, []);

  // ---- PC side status ----
  const [padStatus, setPadStatus] = useState(null);
  const [stalled, setStalled] = useState(false);
  const lastFrameAt = useRef(Date.now());
  const lastResendAt = useRef(0);
  const prevCropRef = useRef(null);

  // ---- send path ----
  const lastSent = useRef({ at: 0, buttons: -1, lt: -1, rt: -1 });
  const sendPad = useCallback(() => {
    const s = pad.snapshot();
    lastSent.current = { at: Date.now(), buttons: s.buttons, lt: s.lt, rt: s.rt };
    send(msg.gamepad(s));
  }, [pad]);
  // Called by the overlay after every routed touch: digital changes go out
  // immediately; analog motion rides the 33 ms timer.
  const onPadChange = useCallback(() => {
    const s = pad.snapshot();
    const l = lastSent.current;
    if (s.buttons !== l.buttons || s.lt !== l.lt || s.rt !== l.rt) {
      pad.takeDirty();
      sendPad();
    }
  }, [pad, sendPad]);

  function onGameFrame(f) {
    lastFrameAt.current = Date.now();
    if (stalled) setStalled(false);
    cursor.feed(f);
  }

  useEffect(() => {
    exitRef.current = false;
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    activateKeepAwakeAsync().catch(() => {});
    // GAME always shows the full screen; stash the tab crop for restore.
    prevCropRef.current = getCommittedCrop();
    send(msg.crop(0, 0, 1, 1));
    setCommittedCrop({ x: 0, y: 0, w: 1, h: 1 });
    setSel({ crop: { x: 0, y: 0, w: 1, h: 1 }, gameLock: true });
    const offPad = addListener((event) => {
      if (event.t === "gamepad") setPadStatus({ on: Boolean(event.on), error: event.error || "" });
    });
    const timer = setInterval(() => {
      if (pad.takeDirty() || Date.now() - lastSent.current.at >= HEARTBEAT_MS) sendPad();
    }, TICK_MS);
    lastFrameAt.current = Date.now();
    lastResendAt.current = 0;
    const stallTimer = setInterval(() => {
      if (exitRef.current) return;
      const idle = Date.now() - lastFrameAt.current;
      if (idle > 4000 && getStatus().connected) {
        setStalled(true);
        if (Date.now() - lastResendAt.current > 4000) {
          lastResendAt.current = Date.now();
          try {
            send(msg.screen(true));
          } catch {
            // best-effort
          }
        }
      } else if (idle <= 4000) {
        setStalled(false);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      clearInterval(stallTimer);
      offPad();
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    if (exitRef.current) return;
    exitRef.current = true;
    try {
      pad.reset();
      send(msg.gamepad(pad.snapshot())); // everything released, sticks centred
      send(msg.gamepadEnd());
      const prev = prevCropRef.current;
      if (prev && (prev.w < 0.995 || prev.h < 0.995)) {
        send(msg.crop(prev.x, prev.y, prev.w, prev.h));
        setCommittedCrop({ ...prev });
        setSel({ crop: { ...prev } });
      } else {
        setCommittedCrop({ x: 0, y: 0, w: 1, h: 1 });
        setSel({ crop: { x: 0, y: 0, w: 1, h: 1 } });
      }
      setSel({ gameLock: false });
    } catch {
      // teardown is best-effort
    }
    deactivateKeepAwake().catch(() => {});
    ScreenOrientation.unlockAsync().catch(() => {});
  }

  function exit() {
    cleanup();
    onExit();
  }

  // ---- edit actions ----
  function startEdit() {
    setShowSettings(false);
    setSelected(null);
    setEditMode(true);
  }
  function resize(d) {
    if (!selected) return;
    setLayout((L) => patchControl(L, selected, { size: stepValue(L.controls[selected].size, d, LIMITS.size) }));
  }
  function fade(d) {
    if (!selected) return;
    setLayout((L) => patchControl(L, selected, { opacity: stepValue(controlOpacity(L, selected), d, LIMITS.opacity) }));
  }
  function fadeGlobal() {
    if (!selected) return;
    setLayout((L) => patchControl(L, selected, { opacity: L.controls[selected].opacity === null ? controlOpacity(L, selected) : null }));
  }
  function hide() {
    if (!selected) return;
    setLayout((L) => patchControl(L, selected, { visible: false }));
    setSelected(null);
  }

  return (
    <View style={styles.root} onLayout={(e) => (cursor.viewRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {layout.showStream && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <ScreenView style={styles.screenInner} onFrame={onGameFrame} />
          {cursor.dot()}
        </View>
      )}
      {!layout.showStream && <ScreenView style={styles.hiddenStream} onFrame={onGameFrame} />}

      <GamepadOverlay
        layout={layout}
        pad={pad}
        editMode={editMode}
        selected={selected}
        onSelect={setSelected}
        onLayoutChange={(next) => setLayout(next)}
        onPadChange={onPadChange}
      />

      {!!(padStatus && !padStatus.on && padStatus.error) && (
        <View style={[styles.banner, styles.bannerErr]} pointerEvents="none">
          <Text style={styles.bannerText} numberOfLines={2}>{padStatus.error}</Text>
        </View>
      )}
      {stalled && !editMode && (
        <View style={[styles.banner, styles.bannerWarn]} pointerEvents="none">
          <Text style={styles.bannerText} numberOfLines={1}>Stream terhenti — mencoba lagi otomatis…</Text>
        </View>
      )}

      {editMode ? (
        <EditToolbar
          layout={layout}
          selected={selected}
          position={!selected ? "center" : layout.controls[selected].y < 0.5 ? "bottom" : "top"}
          onResize={resize}
          onOpacity={fade}
          onOpacityGlobal={fadeGlobal}
          onHide={hide}
          onReset={() => {
            setLayout((L) => ({ ...defaultLayout(), opacity: L.opacity, scale: L.scale, haptics: L.haptics, stickMode: L.stickMode, deadzone: L.deadzone, showStream: L.showStream }));
            setSelected(null);
          }}
          onCancel={() => {
            setLayout(savedRef.current);
            setSelected(null);
            setEditMode(false);
          }}
          onSave={() => {
            commitLayout(layout);
            setSelected(null);
            setEditMode(false);
          }}
        />
      ) : (
        <GameChrome padOn={Boolean(padStatus?.on)} onExit={exit} onSettings={() => setShowSettings((s) => !s)} onEdit={startEdit} />
      )}

      {showSettings && !editMode && (
        <SettingsSheet
          layout={layout}
          onChange={commitLayout}
          onClose={() => setShowSettings(false)}
          onReset={() => commitLayout(defaultLayout())}
          streamControls={<StreamControls compact />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#05070c" },
  screenInner: { flex: 1 },
  // Keeps frames (and the stall watchdog) flowing when the PC screen is hidden.
  hiddenStream: { position: "absolute", width: 1, height: 1, opacity: 0 },
  banner: { position: "absolute", top: 70, alignSelf: "center", maxWidth: "50%", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  bannerErr: { backgroundColor: "rgba(127,29,29,0.88)" },
  bannerWarn: { backgroundColor: "rgba(120,53,15,0.88)" },
  bannerText: { color: "#e8eefc", fontSize: 11, fontWeight: "700", textAlign: "center" },
});
