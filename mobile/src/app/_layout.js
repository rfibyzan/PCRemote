import { DarkTheme, ThemeProvider } from "@react-navigation/native";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useAppFonts } from "../fonts";
import "../settingsync";

// Dark navigation theme: during the tab cross-fade the navigator background
// shows through, and the default (light) theme flashed white.
const THEME = { ...DarkTheme, colors: { ...DarkTheme.colors, background: "#0b0b0d", card: "#141416", border: "#2c2c30", primary: "#a5a1ff" } };

export default function RootLayout() {
  // Optional local UI font (src/fonts): wait for it so the first frame never
  // flips fonts. Without font files this is ready immediately.
  const fontsReady = useAppFonts();
  if (!fontsReady) return null;
  // Gesture handler root: the Look viewer's pan/pinch/double-tap run on the
  // UI thread through react-native-gesture-handler + Reanimated.
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#0b0b0d" }}>
      <ThemeProvider value={THEME}>
      <Stack screenOptions={{ headerShown: false, statusBarStyle: "light", statusBarBackgroundColor: "#0b0b0d", contentStyle: { backgroundColor: "#0b0b0d" } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="pair" />
        <Stack.Screen name="devices" />
      </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
