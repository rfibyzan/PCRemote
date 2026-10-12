import { useRouter } from "expo-router";
import DevicesScreen from "../screens/DevicesScreen";

export default function DevicesRoute() {
  const router = useRouter();
  return (
    <DevicesScreen
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/Pad"))}
      onConnected={() => router.replace("/(tabs)/Pad")}
      onLoggedOut={() => router.replace("/connect")}
    />
  );
}
