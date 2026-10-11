import { Text } from "react-native";
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { useIsConnected } from "../../connection";

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
        tabBarStyle: { backgroundColor: "#151d2e", borderTopColor: "#1e293b" },
        tabBarActiveTintColor: "#7dd3fc",
        tabBarInactiveTintColor: "#94a3b8",
      }}
    >
      <Tabs.Screen
        name="Pad"
        options={{ title: "PAD", tabBarIcon: ({ color }) => <PadIcon color={color} /> }}
      />
      <Tabs.Screen
        name="Type"
        options={{ title: "TYPE", tabBarIcon: ({ color }) => <TypeIcon color={color} /> }}
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
