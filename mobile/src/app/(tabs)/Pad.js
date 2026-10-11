import PadScreen from "../../screens/PadScreen";
import { useTabOrientation } from "../../orientation";

export default function PadRoute() {
  useTabOrientation("portrait");
  return <PadScreen />;
}
