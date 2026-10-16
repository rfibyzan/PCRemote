import Text from "../../AppText";
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { useIsConnected } from "../../connection";
import { familyFor } from "../../fonts";

/**
 * Final navigation: PAD | TYPE | GAME | WIN.
 * Q and Webcam tabs removed; quality/FPS + cam live on via
 * StreamControls and the Cam monitor source. Unauthenticated
 * visits fall back to the pairing screen.
 * Monochrome vector icons (active cyan, inactive muted), labels stay.
 */
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
  if (!connected) return <Redirect href="/connect" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: "#141416", borderTopColor: "#2c2c30" },
        tabBarLabelStyle: familyFor("600") ? { fontFamily: familyFor("600") } : undefined,
        tabBarActiveTintColor: "#a5a1ff",
        tabBarInactiveTintColor: "#8e8e93",
      }}
    >
      <Tabs.Screen
        name="Pad"
        options={{ title: "PAD", tabBarIcon: ({ color }) => <PadIcon color={color} /> }}
      />
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
      <Tabs.Screen
        name="Win"
        options={{ title: "WIN", tabBarIcon: ({ color }) => <WinIcon color={color} /> }}
      />
    </Tabs>
  );
}
