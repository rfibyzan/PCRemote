import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useAppFonts } from "../fonts";

export default function RootLayout() {
  // Optional local UI font (src/fonts): wait for it so the first frame never
  // flips fonts. Without font files this is ready immediately.
  const fontsReady = useAppFonts();
  if (!fontsReady) return null;
  // Gesture handler root: the Look viewer's pan/pinch/double-tap run on the
  // UI thread through react-native-gesture-handler + Reanimated.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, statusBarStyle: "light", statusBarBackgroundColor: "#0b0b0d" }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="pair" />
        <Stack.Screen name="devices" />
      </Stack>
    </GestureHandlerRootView>
  );
}
