const NAMED = {
  Enter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "esc",
  Esc: "esc",
  " ": "space",
  Space: "space",
  Spacebar: "space",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Left: "left",
  Right: "right",
  Up: "up",
  Down: "down",
  Delete: "delete",
  Del: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Control: "ctrl",
  Alt: "alt",
  Shift: "shift",
  Meta: "win",
  "\n": "enter",
  "\b": "backspace",
  "\t": "tab",
};

const PUNCT = {
  "-": "-",
  "=": "=",
  "[": "[",
  "]": "]",
  "\\": "\\",
  ";": ";",
  "'": "'",
  ",": ",",
  ".": ".",
  "/": "/",
  "`": "`",
};

const SHIFT_PUNCT = {
  "!": ["shift", "1"],
  "@": ["shift", "2"],
  "#": ["shift", "3"],
  $: ["shift", "4"],
  "%": ["shift", "5"],
  "^": ["shift", "6"],
  "&": ["shift", "7"],
  "*": ["shift", "8"],
  "(": ["shift", "9"],
  ")": ["shift", "0"],
  _: ["shift", "-"],
  "+": ["shift", "="],
  "{": ["shift", "["],
  "}": ["shift", "]"],
  "|": ["shift", "\\"],
  ":": ["shift", ";"],
  '"': ["shift", "'"],
  "<": ["shift", ","],
  ">": ["shift", "."],
  "?": ["shift", "/"],
  "~": ["shift", "`"],
};

export function pcKeysFromMobileKey(key) {
  const raw = String(key || "");
  if (!raw) return { keys: [], char: "" };
  if (NAMED[raw]) return { keys: [NAMED[raw]], char: "" };
  if (/^F([1-9]|1[0-2])$/i.test(raw)) return { keys: [raw.toLowerCase()], char: "" };
  if (raw.length !== 1) return { keys: [], char: "" };
  if (raw >= "A" && raw <= "Z") return { keys: ["shift", raw.toLowerCase()], char: "" };
  if ((raw >= "a" && raw <= "z") || (raw >= "0" && raw <= "9")) return { keys: [raw], char: "" };
  if (PUNCT[raw]) return { keys: [PUNCT[raw]], char: "" };
  if (SHIFT_PUNCT[raw]) return { keys: SHIFT_PUNCT[raw], char: "" };
  return { keys: [], char: raw };
}

export function sameKeySet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((k, i) => k === b[i]);
}
