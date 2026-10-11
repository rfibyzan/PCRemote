# PC Remote

Remote-desktop app: control a Windows PC from an Android phone over Wi-Fi or
the internet (Cloudflare tunnel + encrypted ntfy announce). Gamepad (ViGEm),
screen streaming, keyboard/mouse, clipboard, webcam, media keys.

```
PCRemote/
├── mobile/          # Expo / React Native Android app (Expo SDK 54)
│   └── src/         # screens, viewer, connection, protocol, gamepad
├── runtime/
│   ├── agent/       # Node.js PC agent (src/) — input, capture, tunnel
│   ├── cloudflared.exe / node.exe / ffmpeg.exe  # NOT in git, see below
│   └── agent/ViGEmClient.dll
├── PCRemote.apk     # sample build
└── HOW-TO.txt       # end-user setup (Indonesian)
```

## Required binaries (not committed — too large for GitHub)

Place these next to `runtime/` as in a release folder:

| File | Where to get it |
|---|---|
| `runtime/node.exe` | Node.js LTS (https://nodejs.org) |
| `runtime/ffmpeg.exe` | Full static build (https://www.gyan.dev/ffmpeg/builds/) |
| `runtime/cloudflared.exe` | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |

`ViGEmClient.dll` ships in `runtime/agent/` (MIT, see `ViGEmClient.LICENSE.txt`);
install [ViGEmBus](https://github.com/ViGEm/ViGEmBus) on the PC for gamepad support.

## Run the PC agent

```bat
cd runtime\agent
npm install
npm start
```

Open the tray icon → dashboard shows the pair code. Tests: `npm test`
(unit 37 + live selftest against a running agent).

## Run the mobile app

```bash
cd mobile
npm install
npx expo start --dev-client   # needs a dev build on the phone
```

Build an APK: `npx eas-cli build --profile preview --platform android`
(EAS account required). Lint: `npx expo lint`.

## Pairing

On the PC tray dashboard read the code once, enter it in the phone app.
Same Wi-Fi or mobile data both work. The code survives restarts
(`revoke` on the dashboard mints a new one and kicks paired phones).
