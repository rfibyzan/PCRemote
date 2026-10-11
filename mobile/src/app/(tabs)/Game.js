import { useRouter } from "expo-router";
import GameScreen from "../../screens/GameScreen";

export default function GameRoute() {
  const router = useRouter();
  return <GameScreen onExit={() => router.replace("/(tabs)/Pad")} />;
}
