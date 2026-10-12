import { Redirect, useLocalSearchParams } from "expo-router";

// Deep link from the PC's QR (scanned with the phone's own camera app):
// pcremote://pair?c=CODE&h=ip:port -> the connect screen pairs with it.
export default function PairRoute() {
  const { c, h } = useLocalSearchParams();
  return <Redirect href={{ pathname: "/connect", params: { c: c || "", h: h || "" } }} />;
}
