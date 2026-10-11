import PadScreen from "../../screens/PadScreen";
import { useTabOrientation } from "../../orientation";

export default function PadRoute() {
  useTabOrientation("free");
  return <PadScreen />;
}
