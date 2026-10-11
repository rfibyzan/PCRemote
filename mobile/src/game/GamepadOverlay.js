/**
 * Xbox-style touch gamepad overlay (Moonlight-like): translucent controls
 * drawn from the layout model, one multi-touch router for every finger, and
 * an edit mode where each control can be dragged, resized, faded or hidden.
 *
 * Touch model: the overlay is ONE view with raw onTouch* handlers and its
 * children are pointerEvents="none". Each changed touch is routed by its
 * pointer identifier from first contact (see router.js), so any number of
 * controls can be held at once. Coordinates are pageX/pageY minus the
 * overlay's measured window origin (locationX is unreliable for secondary
 * pointers on Android).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, Vibration, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { CONTROL_DEFS, CONTROL_IDS, controlBox, controlOpacity, moveControl } from "./layout";
import { TouchRouter } from "./router";

export const FACE_COLORS = { a: "#3ddc84", b: "#ff5c5c", x: "#4aa8ff", y: "#ffc93c" };

const RING = "rgba(255,255,255,0.55)";
const FILL = "rgba(14,18,28,0.55)";
const FILL_ON = "rgba(255,255,255,0.38)";
const TEXT = "rgba(255,255,255,0.92)";
const ACCENT = "#7dd3fc";

function pressedOpacity(base, on) {
  return on ? Math.min(1, base + 0.3) : base;
}

// ---------------------------------------------------------------- visuals

function StickView({ box, def, vis }) {
  const knob = vis.knobs[box.id] || { x: 0, y: 0 };
  const origin = vis.origins[box.id] || { x: 0, y: 0 };
  const clicked = Boolean(vis.pressed[def.click]);
  const d = box.w;
  const k = Math.round(d * 0.46);
  return (
    <View style={{ width: d, height: d, transform: [{ translateX: origin.x }, { translateY: origin.y }] }}>
      <View style={[styles.stickRing, { width: d, height: d, borderRadius: d / 2 }]}>
        <View style={[styles.stickInner, { width: d * 0.7, height: d * 0.7, borderRadius: d * 0.35 }]} />
      </View>
      <View
        style={[
          styles.knob,
          {
            width: k,
            height: k,
            borderRadius: k / 2,
            left: (d - k) / 2,
            top: (d - k) / 2,
            transform: [{ translateX: knob.x }, { translateY: knob.y }],
          },
          clicked && styles.knobClicked,
        ]}
      >
        <Text style={[styles.knobText, { fontSize: Math.max(10, k * 0.26) }]}>{def.side === "left" ? "L" : "R"}</Text>
      </View>
    </View>
  );
}

function DpadView({ box, vis }) {
  const s = box.w;
  const arm = Math.round(s * 0.36);
  const len = Math.round((s - arm) / 2);
  const p = vis.pressed;
  const armStyle = (on) => [styles.dArm, on && styles.dArmOn];
  const glyph = { fontSize: Math.max(10, arm * 0.36) };
  return (
    <View style={{ width: s, height: s }}>
      <View style={[styles.dCenter, { left: len, top: len, width: arm, height: arm }]} />
      <View style={[armStyle(p.up), styles.dTop, { left: len, top: 0, width: arm, height: len + 2 }]}>
        <Text style={[styles.dGlyph, glyph]}>▲</Text>
      </View>
      <View style={[armStyle(p.down), styles.dBottom, { left: len, bottom: 0, width: arm, height: len + 2 }]}>
        <Text style={[styles.dGlyph, glyph]}>▼</Text>
      </View>
      <View style={[armStyle(p.left), styles.dLeft, { left: 0, top: len, width: len + 2, height: arm }]}>
        <Text style={[styles.dGlyph, glyph]}>◀</Text>
      </View>
      <View style={[armStyle(p.right), styles.dRight, { right: 0, top: len, width: len + 2, height: arm }]}>
        <Text style={[styles.dGlyph, glyph]}>▶</Text>
      </View>
    </View>
  );
}

function FaceView({ box, vis }) {
  const s = box.w;
  const b = Math.round(s * 0.36);
  const mid = (s - b) / 2;
  const pos = { y: [mid, 0], a: [mid, s - b], x: [0, mid], b: [s - b, mid] };
  return (
    <View style={{ width: s, height: s }}>
      {["y", "x", "b", "a"].map((n) => {
        const on = Boolean(vis.pressed[n]);
        const c = FACE_COLORS[n];
        return (
          <View
            key={n}
            style={[
              styles.faceBtn,
              { left: pos[n][0], top: pos[n][1], width: b, height: b, borderRadius: b / 2, borderColor: c },
              on && { backgroundColor: c },
            ]}
          >
            <Text style={[styles.faceText, { fontSize: b * 0.44, color: on ? "#0b1220" : c }]}>{n.toUpperCase()}</Text>
          </View>
        );
      })}
    </View>
  );
}

function BumperView({ box, def, vis }) {
  const on = Boolean(vis.pressed[def.button]);
  const left = def.button === "lb";
  return (
    <View
      style={[
        styles.bumper,
        { width: box.w, height: box.h, borderRadius: box.h / 2 },
        left ? { borderTopLeftRadius: box.h } : { borderTopRightRadius: box.h },
        on && styles.on,
      ]}
    >
      <Text style={[styles.label, { fontSize: box.h * 0.42 }]}>{def.label}</Text>
    </View>
  );
}

function TriggerView({ box, def, vis }) {
  const v = vis.triggers[box.id] || 0;
  const r = box.w * 0.42;
  return (
    <View style={[styles.trigger, { width: box.w, height: box.h, borderTopLeftRadius: r, borderTopRightRadius: r }]}>
      <View style={[styles.triggerFill, { height: `${Math.round(v * 100)}%` }]} />
      <Text style={[styles.label, { fontSize: box.h * 0.34 }]}>{def.label}</Text>
    </View>
  );
}

function SmallView({ box, def, vis }) {
  const on = Boolean(vis.pressed[def.button]);
  const s = box.w;
  let content;
  if (def.icon === "guide") content = <MaterialCommunityIcons name="microsoft-xbox" size={s * 0.62} color={on ? "#0b1220" : TEXT} />;
  else if (def.icon === "back") content = <MaterialCommunityIcons name="checkbox-multiple-blank-outline" size={s * 0.46} color={on ? "#0b1220" : TEXT} />;
  else if (def.icon === "start") content = <MaterialCommunityIcons name="menu" size={s * 0.5} color={on ? "#0b1220" : TEXT} />;
  else content = <Text style={[styles.label, { fontSize: s * 0.32, color: on ? "#0b1220" : TEXT }]}>{def.label}</Text>;
  return (
    <View style={[styles.small, { width: s, height: s, borderRadius: s / 2 }, def.icon === "guide" && styles.guide, on && styles.smallOn]}>
      {content}
    </View>
  );
}

const RENDER = { stick: StickView, dpad: DpadView, face: FaceView, bumper: BumperView, trigger: TriggerView, small: SmallView };

const EMPTY_VIS = { pressed: {}, knobs: {}, origins: {}, triggers: {} };

// ---------------------------------------------------------------- overlay

/**
 * Props:
 *  layout, pad, editMode, selected, onSelect(id), onLayoutChange(next, final)
 *  onHeld(): called after any pad change so the screen can flush buttons now.
 */
export default function GamepadOverlay({ layout, pad, editMode, selected, onSelect, onLayoutChange, onPadChange }) {
  const [size, setSize] = useState({ W: 0, H: 0 });
  const sizeRef = useRef(size);
  const originRef = useRef({ x: 0, y: 0 });
  const viewRef = useRef(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const editRef = useRef(editMode);
  editRef.current = editMode;
  const cbRef = useRef({ onPadChange, onLayoutChange, onSelect });
  cbRef.current = { onPadChange, onLayoutChange, onSelect };

  const [vis, setVis] = useState(EMPTY_VIS);
  const rafRef = useRef(0);
  const pendingVis = useRef(null);

  const router = useMemo(
    () =>
      new TouchRouter({
        pad,
        getLayout: () => layoutRef.current,
        getSize: () => sizeRef.current,
        onVisual: (v) => {
          pendingVis.current = v;
          cbRef.current.onPadChange?.();
          if (rafRef.current) return;
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            if (pendingVis.current) setVis({ ...pendingVis.current });
          });
        },
        onHaptic: () => {
          if (layoutRef.current.haptics) Vibration.vibrate(10);
        },
      }),
    [pad],
  );

  // Leaving edit mode or unmounting must never leave a control held.
  useEffect(() => {
    router.releaseAll();
  }, [editMode, router]);
  useEffect(
    () => () => {
      router.releaseAll();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [router],
  );

  // Size comes from onLayout: the same coordinate space the controls are
  // drawn in. (measureInWindow is NOT used for coordinates: with Android
  // edge-to-edge + landscape it can disagree with pageX/pageY by the
  // status-bar / cutout inset, which shifted every touch down-right.)
  const onLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) {
      sizeRef.current = { W: width, H: height };
      setSize({ W: width, H: height });
    }
  }, []);

  // Page -> overlay offset, calibrated from the event's own touch: children
  // are pointerEvents="none", so the overlay is always the event target and
  // pageX - locationX is exactly where its top-left sits in page space.
  function calibrate(ne) {
    const ox = ne.pageX - ne.locationX;
    const oy = ne.pageY - ne.locationY;
    if (Number.isFinite(ox) && Number.isFinite(oy)) originRef.current = { x: ox, y: oy };
  }

  function local(t) {
    return { x: t.pageX - originRef.current.x, y: t.pageY - originRef.current.y };
  }

  // ---- edit-mode drag (single finger, the first one down) ----
  const dragRef = useRef(null);

  function editStart(e) {
    const t = e.nativeEvent.changedTouches?.[0];
    if (!t || dragRef.current) return;
    const p = local(t);
    const { W, H } = sizeRef.current;
    const L = layoutRef.current;
    // In edit mode hidden controls are not drawn, so only visible ones are draggable.
    let hit = null;
    let best = Infinity;
    for (const id of CONTROL_IDS) {
      if (!L.controls[id].visible) continue;
      const b = controlBox(L, id, W, H);
      const dx = Math.abs(p.x - b.cx) / (b.w / 2 + 8);
      const dy = Math.abs(p.y - b.cy) / (b.h / 2 + 8);
      const sc = Math.max(dx, dy);
      if (sc <= 1 && sc < best) {
        best = sc;
        hit = { id, b };
      }
    }
    if (!hit) {
      cbRef.current.onSelect?.(null);
      return;
    }
    cbRef.current.onSelect?.(hit.id);
    dragRef.current = { touch: t.identifier, id: hit.id, dx: hit.b.cx - p.x, dy: hit.b.cy - p.y, moved: false };
  }

  function editMove(e) {
    const st = dragRef.current;
    if (!st) return;
    const t = [...(e.nativeEvent.changedTouches || [])].find((c) => c.identifier === st.touch);
    if (!t) return;
    const p = local(t);
    const { W, H } = sizeRef.current;
    st.moved = true;
    cbRef.current.onLayoutChange?.(moveControl(layoutRef.current, st.id, p.x + st.dx, p.y + st.dy, W, H, 4), false);
  }

  function editEnd(e) {
    const st = dragRef.current;
    if (!st) return;
    const ended = [...(e.nativeEvent.changedTouches || [])].some((c) => c.identifier === st.touch);
    if (!ended && (e.nativeEvent.touches?.length || 0) > 0) return;
    dragRef.current = null;
    if (st.moved) cbRef.current.onLayoutChange?.(layoutRef.current, true);
  }

  // ---- play-mode routing (every finger) ----
  function onTouchStart(e) {
    calibrate(e.nativeEvent);
    if (editRef.current) return editStart(e);
    for (const t of e.nativeEvent.changedTouches || []) {
      const p = local(t);
      router.start(t.identifier, p.x, p.y);
    }
  }
  function onTouchMove(e) {
    if (editRef.current) return editMove(e);
    for (const t of e.nativeEvent.changedTouches || []) {
      const p = local(t);
      router.move(t.identifier, p.x, p.y);
    }
  }
  function onTouchEnd(e) {
    if (editRef.current) return editEnd(e);
    for (const t of e.nativeEvent.changedTouches || []) router.end(t.identifier);
    const left = e.nativeEvent.touches || [];
    if (left.length === 0) router.releaseAll();
    else router.sync(left.map((t) => t.identifier));
  }

  const { W, H } = size;
  return (
    <View
      ref={viewRef}
      style={StyleSheet.absoluteFill}
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {W > 0 &&
        CONTROL_IDS.map((id) => {
          const c = layout.controls[id];
          if (!c.visible) return null;
          const def = CONTROL_DEFS[id];
          const box = controlBox(layout, id, W, H);
          const Comp = RENDER[def.kind];
          const held = !editMode && router.activeControls().includes(id);
          const op = editMode ? Math.max(0.35, controlOpacity(layout, id)) : pressedOpacity(controlOpacity(layout, id), held);
          return (
            <View key={id} pointerEvents="none" style={[styles.slot, { left: box.left, top: box.top, width: box.w, height: box.h }]}>
              <View style={{ opacity: op }}>
                <Comp box={box} def={def} vis={editMode ? EMPTY_VIS : vis} />
              </View>
              {editMode && (
                <View style={[styles.editFrame, selected === id && styles.editFrameSel]}>
                  {selected === id && <Text style={styles.editTag}>{def.label}</Text>}
                </View>
              )}
            </View>
          );
        })}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { position: "absolute", alignItems: "center", justifyContent: "center" },
  on: { backgroundColor: FILL_ON },
  label: { color: TEXT, fontWeight: "800", letterSpacing: 0.5 },
  stickRing: { position: "absolute", left: 0, top: 0, backgroundColor: FILL, borderWidth: 2, borderColor: RING, alignItems: "center", justifyContent: "center" },
  stickInner: { borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  knob: {
    position: "absolute",
    backgroundColor: "rgba(226,232,240,0.88)",
    borderWidth: 3,
    borderColor: "rgba(15,23,42,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  knobClicked: { backgroundColor: ACCENT },
  knobText: { color: "rgba(15,23,42,0.75)", fontWeight: "900" },
  dCenter: { position: "absolute", backgroundColor: FILL },
  dArm: { position: "absolute", backgroundColor: FILL, borderColor: RING, alignItems: "center", justifyContent: "center" },
  dArmOn: { backgroundColor: FILL_ON },
  dTop: { borderTopWidth: 2, borderLeftWidth: 2, borderRightWidth: 2, borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  dBottom: { borderBottomWidth: 2, borderLeftWidth: 2, borderRightWidth: 2, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  dLeft: { borderLeftWidth: 2, borderTopWidth: 2, borderBottomWidth: 2, borderTopLeftRadius: 8, borderBottomLeftRadius: 8 },
  dRight: { borderRightWidth: 2, borderTopWidth: 2, borderBottomWidth: 2, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  dGlyph: { color: TEXT, fontWeight: "900" },
  faceBtn: { position: "absolute", backgroundColor: FILL, borderWidth: 2.5, alignItems: "center", justifyContent: "center" },
  faceText: { fontWeight: "900" },
  bumper: { backgroundColor: FILL, borderWidth: 2, borderColor: RING, alignItems: "center", justifyContent: "center" },
  trigger: {
    backgroundColor: FILL,
    borderWidth: 2,
    borderColor: RING,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  triggerFill: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: FILL_ON },
  small: { backgroundColor: FILL, borderWidth: 2, borderColor: RING, alignItems: "center", justifyContent: "center" },
  guide: { borderColor: "rgba(61,220,132,0.8)" },
  smallOn: { backgroundColor: "rgba(255,255,255,0.85)" },
  editFrame: {
    ...StyleSheet.absoluteFillObject,
    margin: -6,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "rgba(125,211,252,0.6)",
    borderRadius: 10,
  },
  editFrameSel: { borderColor: ACCENT, borderWidth: 2.5, borderStyle: "solid", backgroundColor: "rgba(125,211,252,0.12)" },
  editTag: {
    position: "absolute",
    top: -22,
    alignSelf: "center",
    color: "#0b1220",
    backgroundColor: ACCENT,
    fontSize: 11,
    fontWeight: "800",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
  },
});
