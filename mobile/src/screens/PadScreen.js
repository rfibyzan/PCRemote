/** PAD: shared viewer (layout C) + Left/Hold/Mid/Right row + touchpad in the
 * fixed control area. */
import React from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "../components";
import ViewerPanel from "../viewer";

export default function PadScreen() {
  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <ViewerPanel title="Pad" touchpad actions />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
});
