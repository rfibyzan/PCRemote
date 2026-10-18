import React from "react";
import { StyleSheet, View } from "react-native";
import Text from "../../AppText";
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { Redirect, Tabs, useSegments } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsConnected } from "../../connection";
import { familyFor } from "../../fonts";
import { useSel } from "../../controls";
import ViewerPanel from "../../viewer";

/**
 * Final navigation: PAD | TYPE | GAME | WIN.
 * PAD / TYPE / WIN share ONE viewer, rendered here above the tab navigator,
 * so switching tabs never restarts the stream, the decoder or the camera.
 * The tab scenes only publish their per-tab bits (viewerslot.js); the tab
 * navigator below the viewer is just the tab bar. GAME (landscape, its own
 * stream view) takes the whole screen and the shared viewer steps aside.
 * Unauthenticated visits fall back to the pairing screen.
 */
const TAB_BAR_H = 56;
const VIEWER_TABS = new Set(["Pad", "Type", "Win"]);

function PadIcon({ color }) {
  return <MaterialIcons name="touch-app" size={22} color={color} />;
}
function TypeIcon({ color }) {
  return <Text style={{ color, fontWeight: "800", fontSize: 20, fontFamily: "serif" }}>T</Text>;
}
function GameIcon({ color }) {
  return <Ionicons name="game-controller-outline" size={22} color={color} />;
}
function WinIcon({ color }) {
  return <MaterialCommunityIcons name="microsoft-windows" size={20} color={color} />;
}

export default function TabsLayout() {
  const connected = useIsConnected();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const sel = useSel();
  if (!connected) return <Redirect href="/connect" />;
  const last = segments[segments.length - 1];
  const active = VIEWER_TABS.has(last) ? last : last === "Game" ? "Game" : "Pad";
  const viewerTab = active !== "Game";
  const barH = TAB_BAR_H + insets.bottom;
  // Viewer tabs: the navigator is only as tall as its tab bar (scenes are
  // empty). Fullscreen hides the bar too. GAME: the navigator is everything.
  const navStyle = !viewerTab ? styles.fill : sel.full ? styles.gone : { height: barH };
  return (
    <View style={styles.root}>
      {viewerTab && (
        <SafeAreaView style={styles.fill} edges={sel.full ? [] : ["top", "left", "right"]}>
          <ViewerPanel active={active} />
        </SafeAreaView>
      )}
      <View style={navStyle}>
        <Tabs
          screenOptions={{
            headerShown: false,
            animation: "none",
            sceneStyle: { backgroundColor: "#0b0b0d" },
            tabBarStyle: { backgroundColor: "#141416", borderTopColor: "#2c2c30", height: barH, paddingBottom: insets.bottom },
            tabBarLabelStyle: familyFor("600") ? { fontFamily: familyFor("600") } : undefined,
            tabBarActiveTintColor: "#a5a1ff",
            tabBarInactiveTintColor: "#8e8e93",
          }}
        >
          <Tabs.Screen name="Pad" options={{ title: "PAD", tabBarIcon: ({ color }) => <PadIcon color={color} /> }} />
          <Tabs.Screen
            name="Type"
            options={{ title: "TYPE", tabBarHideOnKeyboard: true, tabBarIcon: ({ color }) => <TypeIcon color={color} /> }}
          />
          <Tabs.Screen
            name="Game"
            options={{
              title: "GAME",
              tabBarStyle: { display: "none" },
              tabBarIcon: ({ color }) => <GameIcon color={color} />,
            }}
          />
          <Tabs.Screen name="Win" options={{ title: "WIN", tabBarIcon: ({ color }) => <WinIcon color={color} /> }} />
        </Tabs>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0b0d" },
  fill: { flex: 1 },
  gone: { height: 0, overflow: "hidden" },
});
