/**
 * GAME chrome: bottom pill (exit / settings / layout), the layout-edit
 * toolbar, and the settings sheet. Pure presentation; state lives in
 * GameScreen.
 */
import React from "react";
import { PanResponder, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Text from "../AppText";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { CONTROL_DEFS, CONTROL_IDS, LIMITS, chromeBox, controlOpacity } from "./layout";

// Same neutral grey + indigo theme as PAD/TYPE/WIN (2026-10-15).
const ACCENT = "#5e5ce6"; // selected fill
const ACCENT_TEXT = "#a5a1ff"; // accent on dark
const PANEL = "rgba(18,18,20,0.96)";
const GROUP = "#1c1c1f";
const BORDER = "#2c2c30";
const TEXT = "#f2f2f5";
const MUTED = "#8e8e93";
const DANGER = "#ff6961";

const pct = (v) => `${Math.round(v * 100)}%`;

export function Stepper({ label, value, onMinus, onPlus, format = pct, small }) {
  return (
    <View style={styles.stepper}>
      {!!label && <Text style={styles.stepLabel}>{label}</Text>}
      <Pressable onPress={onMinus} style={[styles.stepBtn, small && styles.stepBtnSm]} hitSlop={6}>
        <Text style={styles.stepBtnText}>−</Text>
      </Pressable>
      <Text style={styles.stepValue}>{format(value)}</Text>
      <Pressable onPress={onPlus} style={[styles.stepBtn, small && styles.stepBtnSm]} hitSlop={6}>
        <Text style={styles.stepBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

function Chip({ label, active, onPress, icon, danger }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive, danger && styles.chipDanger]} hitSlop={4}>
      {!!icon && <MaterialCommunityIcons name={icon} size={15} color={active ? "#ffffff" : danger ? DANGER : TEXT} />}
      {!!label && <Text style={[styles.chipText, danger && styles.chipTextDanger, active && styles.chipTextActive]}>{label}</Text>}
    </Pressable>
  );
}

const AUTO_COLLAPSE_MS = 4000;

/**
 * Floating menu group (exit / settings / layout) while playing. Its centre
 * comes from layout.chrome (movable in layout edit, default bottom centre).
 * Collapsed: a single "⋯" button that opens the group and folds back after
 * a few seconds without a tap.
 */
export function GameChrome({ chrome, W, H, padOn, onExit, onSettings, onEdit, editMode = false, onMove }) {
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef(null);
  const collapsed = Boolean(chrome?.collapsed);
  const showGroup = !collapsed || open;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const arm = () => {
    clearTimer();
    timer.current = setTimeout(() => setOpen(false), AUTO_COLLAPSE_MS);
  };
  React.useEffect(() => clearTimer, []);
  React.useEffect(() => {
    if (!collapsed || editMode) setOpen(false);
  }, [collapsed, editMode]);

  // Any button press keeps a collapsed group open a little longer, then the
  // action runs (exit / settings / edit fold it right away).
  const act = (fn) => () => {
    clearTimer();
    setOpen(false);
    fn();
  };

  // Layout edit: the whole group is a drag handle.
  const drag = React.useRef({ dx: 0, dy: 0 });
  const live = React.useRef({ size, onMove });
  live.current = { size, onMove };
  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          const { w, h } = live.current.size;
          drag.current = { dx: locationX - w / 2, dy: locationY - h / 2 };
        },
        onPanResponderMove: (e) => {
          const { pageX, pageY } = e.nativeEvent;
          live.current.onMove?.(pageX - drag.current.dx, pageY - drag.current.dy);
        },
      }),
    []
  );

  const box = size.w ? chromeBox(chrome, W, H, size.w, size.h) : null;
  const pos = box ? { left: box.left, top: box.top } : { left: -9999, top: -9999 };
  const onLayout = (e) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.w || height !== size.h) setSize({ w: width, h: height });
  };

  if (editMode) {
    return (
      <View style={[styles.chromeAbs, pos]} onLayout={onLayout} {...responder.panHandlers}>
        <View style={[styles.chrome, styles.chromeEdit]} pointerEvents="none">
          <MaterialCommunityIcons name="drag" size={16} color={ACCENT_TEXT} style={styles.chromeGrip} />
          {collapsed ? (
            <View style={styles.chromeBtn}>
              <MaterialCommunityIcons name="dots-horizontal" size={20} color={TEXT} />
            </View>
          ) : (
            <>
              <View style={styles.chromeBtn}><MaterialCommunityIcons name="close" size={18} color={TEXT} /></View>
              <View style={styles.chromeBtn}><MaterialCommunityIcons name="cog-outline" size={18} color={TEXT} /></View>
              <View style={styles.chromeBtn}><MaterialCommunityIcons name="gamepad-square-outline" size={18} color={TEXT} /></View>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.chromeAbs, pos]} onLayout={onLayout} pointerEvents="box-none">
      {showGroup ? (
        <View style={styles.chrome}>
          <Pressable onPress={act(onExit)} style={styles.chromeBtn} hitSlop={6}>
            <MaterialCommunityIcons name="close" size={18} color={TEXT} />
          </Pressable>
          <Pressable onPress={act(onSettings)} style={styles.chromeBtn} hitSlop={6}>
            <MaterialCommunityIcons name="cog-outline" size={18} color={TEXT} />
          </Pressable>
          <Pressable onPress={act(onEdit)} style={styles.chromeBtn} hitSlop={6}>
            <MaterialCommunityIcons name="gamepad-square-outline" size={18} color={TEXT} />
          </Pressable>
          <View style={[styles.padDot, { backgroundColor: padOn ? "#34c759" : "#6e6e73" }]} />
          {collapsed && (
            <Pressable onPress={() => { clearTimer(); setOpen(false); }} style={styles.chromeBtn} hitSlop={6}>
              <MaterialCommunityIcons name="chevron-left" size={18} color={MUTED} />
            </Pressable>
          )}
        </View>
      ) : (
        <Pressable
          onPress={() => {
            setOpen(true);
            arm();
          }}
          style={[styles.chrome, styles.chromeDot]}
          hitSlop={8}
        >
          <MaterialCommunityIcons name="dots-horizontal" size={20} color={TEXT} />
          <View style={[styles.padDotSm, { backgroundColor: padOn ? "#34c759" : "#6e6e73" }]} />
        </Pressable>
      )}
    </View>
  );
}

/** Toolbar shown in layout-edit mode. */
export function EditToolbar({ layout, selected, position = "center", onToggleChrome, onResize, onOpacity, onOpacityGlobal, onHide, onReset, onCancel, onSave }) {
  const def = selected ? CONTROL_DEFS[selected] : null;
  const c = selected ? layout.controls[selected] : null;
  return (
    <View style={[styles.editWrap, styles[`edit_${position}`]]} pointerEvents="box-none">
      <View style={styles.editBox}>
        <Text style={styles.editTitle}>{def ? def.label : "Geser tombol atau menu untuk memindahkan · ketuk untuk memilih"}</Text>
        {def && (
          <View style={styles.row}>
            <Stepper label="Ukuran" value={c.size} onMinus={() => onResize(-0.1)} onPlus={() => onResize(0.1)} small />
            <Stepper label="Transparan" value={controlOpacity(layout, selected)} onMinus={() => onOpacity(-0.1)} onPlus={() => onOpacity(0.1)} small />
            <Chip label="Ikut global" active={c.opacity === null} onPress={onOpacityGlobal} />
            <Chip icon="eye-off-outline" label="Sembunyikan" onPress={onHide} />
          </View>
        )}
        <View style={styles.row}>
          {!!onToggleChrome && (
            <Chip icon="dots-horizontal" label="Ciutkan menu" active={Boolean(layout.chrome?.collapsed)} onPress={onToggleChrome} />
          )}
          <Chip icon="restore" label="Reset" onPress={onReset} danger />
          <Chip label="Batal" onPress={onCancel} />
          <Chip icon="check" label="Simpan" active onPress={onSave} />
        </View>
      </View>
    </View>
  );
}

/** Settings sheet: global look + behaviour, hidden controls, stream. */
export function SettingsSheet({ layout, onChange, onClose, onReset, streamControls }) {
  const set = (patch) => onChange({ ...layout, ...patch });
  const step = (key, d) => {
    const [lo, hi] = LIMITS[key];
    set({ [key]: Math.round(Math.max(lo, Math.min(hi, layout[key] + d)) * 100) / 100 });
  };
  const toggleVisible = (id) =>
    onChange({ ...layout, controls: { ...layout.controls, [id]: { ...layout.controls[id], visible: !layout.controls[id].visible } } });
  return (
    <View style={styles.sheetWrap} pointerEvents="box-none">
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Pengaturan gamepad</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <MaterialCommunityIcons name="close" size={20} color={TEXT} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          <Text style={styles.section}>Tampilan</Text>
          <View style={styles.group}>
            <Stepper label="Transparansi semua" value={layout.opacity} onMinus={() => step("opacity", -0.05)} onPlus={() => step("opacity", 0.05)} />
            <View style={styles.sep} />
            <Stepper label="Ukuran semua" value={layout.scale} onMinus={() => step("scale", -0.05)} onPlus={() => step("scale", 0.05)} />
            <View style={styles.sep} />
            <View style={styles.row}>
              <Chip icon="monitor" label="Tampilkan layar PC" active={layout.showStream} onPress={() => set({ showStream: !layout.showStream })} />
              <Chip icon="vibrate" label="Getar" active={layout.haptics} onPress={() => set({ haptics: !layout.haptics })} />
              <Chip
                icon="dots-horizontal"
                label="Ciutkan menu"
                active={Boolean(layout.chrome?.collapsed)}
                onPress={() => set({ chrome: { ...layout.chrome, collapsed: !layout.chrome?.collapsed } })}
              />
            </View>
          </View>

          <Text style={styles.section}>Analog</Text>
          <View style={styles.group}>
            <View style={styles.row}>
              <Chip label="Stik tetap" active={layout.stickMode === "fixed"} onPress={() => set({ stickMode: "fixed" })} />
              <Chip label="Stik melayang" active={layout.stickMode === "floating"} onPress={() => set({ stickMode: "floating" })} />
            </View>
            <View style={styles.sep} />
            <Stepper label="Deadzone" value={layout.deadzone} onMinus={() => step("deadzone", -0.02)} onPlus={() => step("deadzone", 0.02)} />
          </View>
          <Text style={styles.hint}>Ketuk dua kali lalu tahan stik untuk L3 / R3.</Text>

          <Text style={styles.section}>Tombol yang ditampilkan</Text>
          <View style={styles.group}>
            <View style={styles.wrapRow}>
              {CONTROL_IDS.map((id) => (
                <Chip key={id} label={CONTROL_DEFS[id].label} active={layout.controls[id].visible} onPress={() => toggleVisible(id)} />
              ))}
            </View>
          </View>

          {!!streamControls && (
            <>
              <Text style={styles.section}>Stream</Text>
              <View style={styles.group}>{streamControls}</View>
            </>
          )}

          <View style={[styles.group, styles.resetGroup]}>
            <Chip icon="restore" label="Reset semua ke default" onPress={onReset} danger />
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingVertical: 8 },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingVertical: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#2c2c30",
  },
  chipActive: { backgroundColor: ACCENT },
  chipDanger: { backgroundColor: "rgba(255,105,97,0.14)" },
  chipText: { color: TEXT, fontSize: 12, fontWeight: "500" },
  chipTextDanger: { color: DANGER },
  chipTextActive: { color: "#ffffff", fontWeight: "700" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8 },
  stepLabel: { color: TEXT, fontSize: 13, fontWeight: "400", flex: 1, minWidth: 70 },
  stepBtn: { width: 34, height: 30, borderRadius: 9, backgroundColor: "#2c2c30", alignItems: "center", justifyContent: "center" },
  stepBtnSm: { width: 30, height: 28 },
  stepBtnText: { color: TEXT, fontSize: 17, fontWeight: "500", marginTop: -2 },
  stepValue: { color: ACCENT_TEXT, fontSize: 12, fontWeight: "700", minWidth: 40, textAlign: "center" },
  chromeAbs: { position: "absolute" },
  chromeEdit: { borderWidth: 2, borderColor: ACCENT, borderStyle: "dashed" },
  chromeGrip: { marginLeft: 6, marginRight: 2 },
  chromeDot: { width: 44, height: 36, justifyContent: "center", paddingHorizontal: 0 },
  padDotSm: { position: "absolute", right: 6, top: 6, width: 6, height: 6, borderRadius: 3 },
  chrome: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(18,18,20,0.6)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  chromeBtn: { width: 34, height: 30, alignItems: "center", justifyContent: "center" },
  padDot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 8 },
  editWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  // The toolbar sits on the half of the screen AWAY from the selected
  // control, so the control being edited is never hidden behind it.
  edit_center: { top: "34%" },
  edit_top: { top: 8 },
  edit_bottom: { bottom: 8 },
  editBox: { maxWidth: "62%", backgroundColor: PANEL, borderRadius: 16, borderWidth: 1, borderColor: BORDER, paddingHorizontal: 12, paddingVertical: 8 },
  editTitle: { color: TEXT, fontSize: 13, fontWeight: "700", textAlign: "center", paddingTop: 2 },
  sheetWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { width: 420, maxWidth: "70%", maxHeight: "88%", backgroundColor: PANEL, borderRadius: 18, borderWidth: 1, borderColor: BORDER },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  sheetTitle: { color: TEXT, fontSize: 16, fontWeight: "700" },
  sheetBody: { paddingHorizontal: 14, paddingBottom: 16 },
  // iOS-style grouped settings: muted section label, then a rounded card.
  section: { color: MUTED, fontSize: 11, fontWeight: "500", letterSpacing: 0.6, textTransform: "uppercase", marginTop: 14, marginBottom: 6, marginLeft: 4 },
  group: { backgroundColor: GROUP, borderRadius: 12, paddingHorizontal: 12 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: "#3a3a3e" },
  resetGroup: { marginTop: 16, alignItems: "flex-start" },
  hint: { color: MUTED, fontSize: 11, marginTop: 6, marginLeft: 4 },
});
