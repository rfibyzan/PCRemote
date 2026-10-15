# Local UI font (optional, not in git)

The app uses SF Pro Display when these three files are here, and the Android
system font (Roboto) when they are not:

- `SF-Pro-Display-Regular.otf`
- `SF-Pro-Display-Medium.otf`
- `SF-Pro-Display-Bold.otf`

They are ignored by git (`mobile/.gitignore`) because the font's license does
not allow redistributing it, so a fresh clone never contains them. Put your own
copies here with exactly these names.

- Metro (`npx expo start`) picks them up automatically (`metro.config.js`
  checks the files and aliases `pcremote-local-fonts`). Restart Metro with
  `--clear` after adding or removing them.
- EAS builds still upload them: `.easignore` (repo root, plus `mobile/.easignore`)
  repeats the `.gitignore` rules and re-includes `mobile/assets/fonts/*.otf`.
  Keep `.easignore` in sync when you change a `.gitignore`.
