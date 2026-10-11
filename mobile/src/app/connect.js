import { useRouter } from "expo-router";
import ConnectScreen from "../screens/ConnectScreen";

export default function ConnectRoute() {
  const router = useRouter();
  return <ConnectScreen onConnected={() => router.replace("/(tabs)/Pad")} />;
}
