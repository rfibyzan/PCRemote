import WinScreen from "../../screens/WinScreen";
import { useTabOrientation } from "../../orientation";

export default function WinRoute() {
  useTabOrientation("portrait");
  return <WinScreen />;
}
