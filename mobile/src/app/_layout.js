import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";

export default function RootLayout() {
  // Gesture handler root: the Look viewer's pan/pinch/double-tap run on the
  // UI thread through react-native-gesture-handler + Reanimated.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, statusBarStyle: "light", statusBarBackgroundColor: "#0b1220" }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="pair" />
      </Stack>
    </GestureHandlerRootView>
  );
}
