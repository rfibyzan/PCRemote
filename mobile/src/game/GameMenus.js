/**
 * GAME chrome: bottom pill (exit / settings / layout), the layout-edit
 * toolbar, and the settings sheet. Pure presentation; state lives in
 * GameScreen.
 */
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { CONTROL_DEFS, CONTROL_IDS, LIMITS, controlOpacity } from "./layout";

const ACCENT = "#7dd3fc";
const PANEL = "rgba(11,18,32,0.94)";
const BORDER = "#1e293b";
const TEXT = "#e8eefc";
const MUTED = "#94a3b8";

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
      {!!icon && <MaterialCommunityIcons name={icon} size={15} color={active ? "#0b1220" : TEXT} />}
      {!!label && <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>}
    </Pressable>
  );
}

/** Small floating pill at the bottom centre while playing. */
export function GameChrome({ padOn, onExit, onSettings, onEdit }) {
  return (
    <View style={styles.chromeWrap} pointerEvents="box-none">
      <View style={styles.chrome}>
        <Pressable onPress={onExit} style={styles.chromeBtn} hitSlop={6}>
          <MaterialCommunityIcons name="close" size={18} color={TEXT} />
        </Pressable>
        <Pressable onPress={onSettings} style={styles.chromeBtn} hitSlop={6}>
          <MaterialCommunityIcons name="cog-outline" size={18} color={TEXT} />
        </Pressable>
        <Pressable onPress={onEdit} style={styles.chromeBtn} hitSlop={6}>
          <MaterialCommunityIcons name="gamepad-square-outline" size={18} color={TEXT} />
        </Pressable>
        <View style={[styles.padDot, { backgroundColor: padOn ? "#3ddc84" : "#64748b" }]} />
      </View>
    </View>
  );
}

/** Toolbar shown in layout-edit mode. */
export function EditToolbar({ layout, selected, position = "center", onResize, onOpacity, onOpacityGlobal, onHide, onReset, onCancel, onSave }) {
  const def = selected ? CONTROL_DEFS[selected] : null;
  const c = selected ? layout.controls[selected] : null;
  return (
    <View style={[styles.editWrap, styles[`edit_${position}`]]} pointerEvents="box-none">
      <View style={styles.editBox}>
        <Text style={styles.editTitle}>{def ? def.label : "Geser tombol untuk memindahkan · ketuk untuk memilih"}</Text>
        {def && (
          <View style={styles.row}>
            <Stepper label="Ukuran" value={c.size} onMinus={() => onResize(-0.1)} onPlus={() => onResize(0.1)} small />
            <Stepper label="Transparan" value={controlOpacity(layout, selected)} onMinus={() => onOpacity(-0.1)} onPlus={() => onOpacity(0.1)} small />
            <Chip label="Ikut global" active={c.opacity === null} onPress={onOpacityGlobal} />
            <Chip icon="eye-off-outline" label="Sembunyikan" onPress={onHide} />
          </View>
        )}
        <View style={styles.row}>
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
          <Stepper label="Transparansi semua" value={layout.opacity} onMinus={() => step("opacity", -0.05)} onPlus={() => step("opacity", 0.05)} />
          <Stepper label="Ukuran semua" value={layout.scale} onMinus={() => step("scale", -0.05)} onPlus={() => step("scale", 0.05)} />
          <View style={styles.row}>
            <Chip icon="monitor" label="Tampilkan layar PC" active={layout.showStream} onPress={() => set({ showStream: !layout.showStream })} />
            <Chip icon="vibrate" label="Getar" active={layout.haptics} onPress={() => set({ haptics: !layout.haptics })} />
          </View>

          <Text style={styles.section}>Analog</Text>
          <View style={styles.row}>
            <Chip label="Stik tetap" active={layout.stickMode === "fixed"} onPress={() => set({ stickMode: "fixed" })} />
            <Chip label="Stik melayang" active={layout.stickMode === "floating"} onPress={() => set({ stickMode: "floating" })} />
          </View>
          <Stepper label="Deadzone" value={layout.deadzone} onMinus={() => step("deadzone", -0.02)} onPlus={() => step("deadzone", 0.02)} />
          <Text style={styles.hint}>Ketuk dua kali lalu tahan stik untuk L3 / R3.</Text>

          <Text style={styles.section}>Tombol yang ditampilkan</Text>
          <View style={styles.wrapRow}>
            {CONTROL_IDS.map((id) => (
              <Chip key={id} label={CONTROL_DEFS[id].label} active={layout.controls[id].visible} onPress={() => toggleVisible(id)} />
            ))}
          </View>

          {!!streamControls && (
            <>
              <Text style={styles.section}>Stream</Text>
              {streamControls}
            </>
          )}

          <View style={[styles.row, { marginTop: 14 }]}>
            <Chip icon="restore" label="Reset semua ke default" onPress={onReset} danger />
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(30,41,59,0.9)",
    borderWidth: 1,
    borderColor: "#334155",
  },
  chipActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipDanger: { borderColor: "rgba(248,113,113,0.6)" },
  chipText: { color: TEXT, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: "#0b1220" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  stepLabel: { color: MUTED, fontSize: 12, fontWeight: "700", minWidth: 70 },
  stepBtn: { width: 34, height: 30, borderRadius: 8, backgroundColor: "rgba(30,41,59,0.95)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#334155" },
  stepBtnSm: { width: 30, height: 28 },
  stepBtnText: { color: TEXT, fontSize: 17, fontWeight: "800", marginTop: -2 },
  stepValue: { color: TEXT, fontSize: 12, fontWeight: "800", minWidth: 40, textAlign: "center" },
  chromeWrap: { position: "absolute", left: 0, right: 0, bottom: 6, alignItems: "center" },
  chrome: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(11,18,32,0.55)",
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
  editBox: { maxWidth: "62%", backgroundColor: PANEL, borderRadius: 14, borderWidth: 1, borderColor: BORDER, paddingHorizontal: 12, paddingVertical: 10 },
  editTitle: { color: TEXT, fontSize: 13, fontWeight: "800", textAlign: "center" },
  sheetWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { width: 420, maxWidth: "70%", maxHeight: "88%", backgroundColor: PANEL, borderRadius: 16, borderWidth: 1, borderColor: BORDER },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  sheetTitle: { color: TEXT, fontSize: 15, fontWeight: "800" },
  sheetBody: { paddingHorizontal: 14, paddingBottom: 14 },
  section: { color: ACCENT, fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginTop: 12 },
  hint: { color: MUTED, fontSize: 11, marginTop: 6 },
});
