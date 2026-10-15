// Metro config: Expo defaults + one alias.
//
// "pcremote-local-fonts" resolves to src/fonts/local.js when the optional,
// NOT-committed font files exist in assets/fonts (see assets/fonts/README.md),
// otherwise to src/fonts/none.js. So a fresh clone without the fonts still
// bundles and simply uses the Android system font (Roboto).
const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const FONT_DIR = path.join(__dirname, "assets", "fonts");
const FONT_FILES = ["SF-Pro-Display-Regular.otf", "SF-Pro-Display-Medium.otf", "SF-Pro-Display-Bold.otf"];
const haveFonts = () => FONT_FILES.every((f) => fs.existsSync(path.join(FONT_DIR, f)));

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "pcremote-local-fonts") {
    const file = haveFonts() ? "local.js" : "none.js";
    return { type: "sourceFile", filePath: path.join(__dirname, "src", "fonts", file) };
  }
  return (upstream || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
