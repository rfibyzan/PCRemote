import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, statusBarStyle: "light", statusBarBackgroundColor: "#0b1220" }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="connect" />
    </Stack>
  );
}
