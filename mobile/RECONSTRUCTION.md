# Mobile reconstruction — behavioral contract (from original v6 APK)

The original Expo source is unavailable (upstream repo holds docs only).
This client is a clean-room reconstruction: behavior-compatible, not
source-identical. Reference: `PCRemote.apk` (Expo SDK 54, Hermes bundle,
package `com.hyte70.pcremote`) + `runtime/agent` source.

## Navigation (APK string table order)
`Game | Pad | Q | Type | Webcam | Win` (+ PAD sub-modes `Look | Click`).
Implemented with Expo Router Tabs; `Game` hides the tab bar (fullscreen).

## Connection / pairing
- SecureStore keys: `pcremote.lock` (code), `pcremote.quality` (Q panel),
  `pcremote.hosts` (remembered PCs).
- Crypto matches agent `crypto.js`: `normalizeCode`, room
  `sha256("pcremote-room:CODE")[0:20]`, key `sha256("pcremote-v1:CODE")`,
  ntfy announce `nonceB64.boxB64` NaCl secretbox over topics
  `pcremote{room}` on ntfy.sh / adminforge.de / envs.net.
- Discovery: remembered hosts (`GET /health`) → ntfy poll → manual host.
  Status strings preserved: "Looking for your PC…",
  "Finding this PC on the internet…", "Looking on Wi-Fi…",
  "This PC agent is not reachable…", "Disconnected. Reconnecting…",
  "Enter the code shown on the PC".
- One shared WebSocket per app session; `auth` → `hello`; 25 s `ping`.

## PAD (protected behavior)
Touchpad (`move` rel ×1.5, 2-finger `scroll`), Left/Mid/Right tap,
Hold (down-only) + release for drag, `Click` vs `Look` hint texts,
live screen + monitor chips (`monitor`).

## Q (protected behavior)
Presets lite/low/med/high/super + `qStep` (−5…8) / `fpsStep` (−5…10)
over the existing `quality` message; persisted to `pcremote.quality`.

## TYPE (protected behavior)
Full key grid + free-text field (`text`), tap (`key`), hold (down-only),
chords (`combo` hold/release), arrows/F-keys/modifiers.

## WEBCAM (protected behavior)
`cam(true/false)`, "Starting webcam…" / error line, screen chips to exit,
hint "Webcam: drag to look, pinch to zoom. Tap a screen chip to go back."

## WIN (protected behavior)
Screen + monitor chips, app launcher allowlist
(explorer/taskmgr/notepad/terminal/browser/settings/calc) + URL open,
media keys, workstation lock, clipboard get/set.

## Screen frames (shared)
16-byte `PR` header + JPEG (`mon` single/all/cam, w/h, cursor cx/cy,
crop). Last-valid-frame rendering: invalid data never blanks the view;
stable component identity (no per-frame remount).

## GAME (new, existing Game entry)
- Landscape + keep-awake + fullscreen; PC screen background (same `PR`
  channel). Stream quality belongs to the Q tab — GAME sends no quality
  messages and shows no quality UI.
- Screen renderer is double-buffered: the visible frame is never blanked
  while the next JPEG decodes; invalid frames are ignored.
- Xbox overlay: 2 analog sticks (±1, deadzone 0.12 default/adjustable,
  auto-center, +Y up, double-tap-hold = L3/R3), 8-way D-pad, A/B/X/Y,
  LB/RB, LT/RT (0…1, tap = full), Back/Start/Guide, optional L3/R3 buttons.
- Layout is data (`src/game/layout.js`): every control movable, resizable,
  per-control opacity, hideable; global opacity/scale, haptics, fixed or
  floating sticks. Saved to `gamepad-layout-v2.json` in the document dir.
- `{t:"gamepad",state}` at ~30 Hz when dirty + immediate button/trigger
  flush + 500 ms heartbeat; multi-touch via one router tracking every
  pointer id from first contact (`src/game/router.js`); exit sends
  zero-state + `gamepadEnd`.
- Audio: `{t:"gameAudio",on}` → `PA`-header Opus packets → rolling Ogg
  segments → platform decoder. Starts/stops with GAME only (no Audio tab).

## Known differences from v6 APK
- Clean-room UI styling (same dark theme + labels, not pixel-identical).
- GAME content is new (v6 Game entry behavior could not be recovered
  from bytecode).
- Audio uses segmented playback (~1–2 s latency) instead of an
  unknown original implementation (no audio streaming existed agent-side).
