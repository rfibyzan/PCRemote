/**
 * Text with the app's UI font. Drop-in for react-native's Text: maps the
 * style's fontWeight to the matching local font family (src/fonts) and keeps
 * any explicit fontFamily (monospace logs, the serif "T" tab icon). Without
 * local font files it renders exactly like the system Text.
 */
import React, { forwardRef } from "react";
import { StyleSheet, Text as RNText } from "react-native";
import { familyFor } from "./fonts";

const AppText = forwardRef(function AppText({ style, ...props }, ref) {
  const flat = StyleSheet.flatten(style) || {};
  const fam = flat.fontFamily ? null : familyFor(flat.fontWeight);
  if (!fam) return <RNText ref={ref} style={style} {...props} />;
  // Custom families carry their own weight; a fontWeight on top makes
  // Android synthesize a second bold.
  return <RNText ref={ref} style={[style, { fontFamily: fam, fontWeight: "normal" }]} {...props} />;
});

export default AppText;
