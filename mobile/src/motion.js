/** Shared motion, Sill-style: open with a short spring, close with a quick
 * ease-out fade. Android "Remove animations" (reduced motion) = fade only.
 * Nothing here blocks input: touches pass while a panel animates. */
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  runOnJS,
  withRepeat,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { MOTION, panelFrame } from "./motionmath";

export { MOTION };

const OPEN = { duration: MOTION.openMs, dampingRatio: MOTION.damping };
const CLOSE = { duration: MOTION.closeMs, easing: Easing.out(Easing.quad) };

/** Keeps children mounted until the close animation ends; progress 0..1. */
export function useMountMotion(visible) {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const p = useSharedValue(0);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      p.value = reduce ? withTiming(1, CLOSE) : withSpring(1, OPEN);
    } else {
      p.value = withTiming(0, CLOSE, (fin) => {
        if (fin) runOnJS(setMounted)(false);
      });
    }
  }, [visible, reduce, p]);
  return { mounted, p, reduce };
}

/** Holds the last non-null value so a panel can fade out with its content. */
export function useLatched(value) {
  const ref = useRef(value);
  if (value != null) ref.current = value;
  return value ?? ref.current;
}

const Ctx = createContext({ p: null, reduce: true });

/** Modal with an animated dim layer. Put a MotionPanel inside. Remove the
 * backgroundColor from the shade the children draw: the dim is drawn here. */
export function MotionModal({ visible, onRequestClose, dim = 0.55, children }) {
  const m = useMountMotion(visible);
  const dimStyle = useAnimatedStyle(() => ({ opacity: m.p.value > 1 ? 1 : m.p.value }));
  return (
    <Modal visible={m.mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onRequestClose}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${dim})` }, dimStyle]} />
      <Ctx.Provider value={m}>{children}</Ctx.Provider>
    </Modal>
  );
}

/** kind: "sheet" (rises from the bottom), "pop" (grows from 94% at origin),
 * "fade". origin: a transformOrigin string such as "top right".
 * from: {x, y} screen point (pageX/pageY of the press) to grow out of. */
export function MotionPanel({ kind = "pop", origin = "center", from = null, style, children, pointerEvents }) {
  const { p, reduce } = useContext(Ctx);
  const { width, height } = useWindowDimensions();
  // from: the screen point a menu was opened at (a held tile). The panel is
  // centred, so it starts offset toward that point and small.
  const k = reduce ? "fade" : from ? "touch" : kind;
  const dx = from ? from.x - width / 2 : 0;
  const dy = from ? from.y - height / 2 : 0;
  const anim = useAnimatedStyle(() => {
    const v = p ? p.value : 1;
    const f = panelFrame(k, v, height, dx, dy);
    return { opacity: f.opacity, transform: [{ translateX: f.x }, { translateY: f.y }, { scale: f.scale }] };
  });
  return (
    <Animated.View pointerEvents={pointerEvents} style={[style, { transformOrigin: origin }, anim]}>
      {children}
    </Animated.View>
  );
}

/** Inline (non-modal) panel that appears/disappears with the same motion. */
export function MotionView({ visible, kind = "pop", origin = "center", style, children, pointerEvents }) {
  const m = useMountMotion(visible);
  if (!m.mounted) return null;
  return (
    <Ctx.Provider value={m}>
      <MotionPanel kind={kind} origin={origin} style={style} pointerEvents={pointerEvents}>
        {children}
      </MotionPanel>
    </Ctx.Provider>
  );
}


/** Pressable that dips to 96% while held and springs back. Same props as
 * Pressable; style may be a function of { pressed }. */
// Keys that place a button in its parent; they stay on the outer Pressable.
// Everything else (background, padding, border, inner layout) is drawn by the
// inner Animated.View, which is what scales.
const OUTER_KEYS = new Set([
  "flex", "flexGrow", "flexShrink", "flexBasis", "alignSelf",
  "margin", "marginTop", "marginBottom", "marginLeft", "marginRight", "marginHorizontal", "marginVertical", "marginStart", "marginEnd",
  "position", "top", "bottom", "left", "right", "start", "end", "zIndex",
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "aspectRatio",
]);

function splitStyle(style) {
  const flat = StyleSheet.flatten(style) || {};
  const outer = {};
  const inner = {};
  for (const k in flat) (OUTER_KEYS.has(k) ? outer : inner)[k] = flat[k];
  return [outer, inner];
}

/** A Pressable that shrinks a touch while held (Sill-style). An animated
 * Pressable drops its style on this RN/Reanimated build (buttons lost their
 * background), so the Pressable stays plain and an inner Animated.View draws
 * the button and scales. `style` may be a function of { pressed }. */
export function PressScale({ style, onPressIn, onPressOut, scaleTo = MOTION.pressScale, children, ...rest }) {
  const reduce = useReducedMotion();
  const s = useSharedValue(0);
  const [pressed, setPressed] = useState(false);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(s.value, [0, 1], [1, scaleTo]) }] }));
  const [outer, inner] = splitStyle(typeof style === "function" ? style({ pressed }) : style);
  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        setPressed(true);
        if (!reduce) s.value = withTiming(1, { duration: 80 });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        s.value = withSpring(0, { duration: 260, dampingRatio: 0.55 });
        onPressOut?.(e);
      }}
      style={outer}
    >
      <Animated.View style={[styles.fill, inner, anim]}>{typeof children === "function" ? children({ pressed }) : children}</Animated.View>
    </Pressable>
  );
}

/** Spring a numeric value (e.g. a sliding indicator's x). */
export function useSpringValue(target) {
  const reduce = useReducedMotion();
  const v = useSharedValue(target);
  useEffect(() => {
    v.value = reduce ? withTiming(target, CLOSE) : withSpring(target, OPEN);
  }, [target, reduce, v]);
  return v;
}

/** Layout-animation entering presets (Reanimated): pass as entering={popIn}.
 * Reanimated already skips them when the system asks for reduced motion. */
export function popIn() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: MOTION.popFrom - 0.04 }] },
    animations: {
      opacity: withTiming(1, { duration: 160 }),
      transform: [{ scale: withSpring(1, { duration: MOTION.openMs, dampingRatio: 0.7 }) }],
    },
  };
}

export function riseIn() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 40 }] },
    animations: {
      opacity: withTiming(1, { duration: 160 }),
      transform: [{ translateY: withSpring(0, { duration: MOTION.openMs, dampingRatio: MOTION.damping }) }],
    },
  };
}

/** Segmented tabs whose highlight slides to the chosen tab with a spring
 * (rows or columns: it follows each tab's measured box). renderLabel(item,
 * active) draws each label; tabStyle may be a function of (item, active). */
export function SlideTabs({ items, value, onChange, style, tabStyle, activeColor, radius = 7, renderLabel }) {
  const [boxes, setBoxes] = useState({});
  const box = boxes[value];
  const x = useSpringValue(box ? box.x : 0);
  const y = useSpringValue(box ? box.y : 0);
  const w = useSpringValue(box ? box.w : 0);
  const h = useSpringValue(box ? box.h : 0);
  const anim = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }], width: w.value, height: h.value }));
  return (
    <Animated.View style={style}>
      {!!box && <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, left: 0, borderRadius: radius, backgroundColor: activeColor }, anim]} />}
      {items.map((it) => (
        <Pressable
          key={it}
          onPress={() => onChange(it)}
          onLayout={(e) => {
            const l = e.nativeEvent.layout;
            setBoxes((b) => {
              const o = b[it];
              return o && o.x === l.x && o.y === l.y && o.w === l.width && o.h === l.height ? b : { ...b, [it]: { x: l.x, y: l.y, w: l.width, h: l.height } };
            });
          }}
          style={typeof tabStyle === "function" ? tabStyle(it, it === value) : tabStyle}
        >
          {renderLabel(it, it === value)}
        </Pressable>
      ))}
    </Animated.View>
  );
}

/** Gentle breathing while `on` (connecting, waiting for a scan): opacity
 * down to `min` and scale up to `grow`, back and forth. Still when off or
 * when the system asks for reduced motion. */
export function Pulse({ on, min = 0.55, grow = 1, ms = MOTION.pulseMs, style, children }) {
  const reduce = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (on && !reduce) {
      t.value = withRepeat(withTiming(1, { duration: ms, easing: Easing.inOut(Easing.quad) }), -1, true);
    } else {
      cancelAnimation(t);
      t.value = withTiming(0, CLOSE);
    }
    return () => cancelAnimation(t);
  }, [on, reduce, ms, t]);
  const anim = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [1, min]),
    transform: [{ scale: interpolate(t.value, [0, 1], [1, grow]) }],
  }));
  return <Animated.View style={[style, anim]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  // The inner face fills whatever box the outer Pressable got from its parent.
  fill: { flexGrow: 1, alignSelf: "stretch" },
});
