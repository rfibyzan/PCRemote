/** Two installable variants from one codebase.
 *
 *   APP_VARIANT=development  -> "PC Remote (dev)", com.hyte70.pcremote.dev,
 *                               scheme pcremote-dev (eas.json profile "development")
 *   (unset)                  -> "PC Remote", com.hyte70.pcremote, scheme pcremote
 *                               (profiles "preview" / "production")
 *
 * Different package IDs = both apps installed side by side; each keeps its own
 * pairing/settings. The in-app QR scanner parses pcremote:// itself, so pairing
 * works in both; links opened from outside the app go to the stable one.
 * Everything else comes from app.json.
 */
const IS_DEV = process.env.APP_VARIANT === "development";

module.exports = ({ config }) => {
  if (!IS_DEV) return config;
  return {
    ...config,
    name: "PC Remote (dev)",
    scheme: "pcremote-dev",
    android: { ...config.android, package: "com.hyte70.pcremote.dev" },
    ios: { ...config.ios, bundleIdentifier: "com.hyte70.pcremote.dev" },
  };
};
