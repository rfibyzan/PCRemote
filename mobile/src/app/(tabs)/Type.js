import TypeScreen from "../../screens/TypeScreen";
import { useTabOrientation } from "../../orientation";

export default function TypeRoute() {
  useTabOrientation("portrait");
  return <TypeScreen />;
}
