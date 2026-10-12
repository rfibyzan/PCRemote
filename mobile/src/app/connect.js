import { useLocalSearchParams, useRouter } from "expo-router";
import ConnectScreen from "../screens/ConnectScreen";

export default function ConnectRoute() {
  const router = useRouter();
  const { c, h } = useLocalSearchParams();
  return <ConnectScreen qrParams={c ? { c, h } : null} onConnected={() => router.replace("/(tabs)/Pad")} />;
}
