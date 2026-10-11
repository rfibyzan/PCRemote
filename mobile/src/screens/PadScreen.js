/** PAD: stream controls + universal viewer + connection status. */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "../components";
import { ConnDot } from "../controls";
import ViewerPanel from "../viewer";

export default function PadScreen() {
  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Pad</Text>
        <ConnDot />
      </View>
      <ViewerPanel touchpad actions />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, height: 32 },
  title: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
});
