/** Optional local UI font (files not in git, see assets/fonts/README.md).
 * Only bundled when metro.config.js finds all three files. Android has no
 * upright SemiBold here, so 500-600 use Medium and 700+ use Bold. */
export default {
  regular: "SFProDisplay-Regular",
  medium: "SFProDisplay-Medium",
  bold: "SFProDisplay-Bold",
  files: {
    "SFProDisplay-Regular": require("../../assets/fonts/SF-Pro-Display-Regular.otf"),
    "SFProDisplay-Medium": require("../../assets/fonts/SF-Pro-Display-Medium.otf"),
    "SFProDisplay-Bold": require("../../assets/fonts/SF-Pro-Display-Bold.otf"),
  },
};
