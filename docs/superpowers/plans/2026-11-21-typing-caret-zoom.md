# Zoom Ikut Caret Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Di mode ketik, kamera viewer HP mengikuti caret PC dengan zoom yang dihitung dari tinggi caret, bisa diatur dengan cubit dan dimatikan di pengaturan.

**Architecture:** Agent membaca caret (Win32 `GetGUIThreadInfo` via koffi, lalu UI Automation lewat proses PowerShell yang hidup terus) hanya untuk koneksi yang meminta (`caretWatch`), menormalkan ke tampilan koneksi itu (`monitorFor(ws)`, sama seperti `cursorOnMonitor`, jadi tampilan "Semua" ikut tertangani), dan mengirim `{t:"caret"}` saat berubah. HP: matematika murni di `caretmath.js`; `viewer.js` menjalankan mesin status ikut/manual; `TypeScreen.js` menyimpan pengaturan dan menyalakan/mematikan `caretWatch`.

**Tech Stack:** Agent: Node ESM + `koffi`, PowerShell 5.1 (`System.Windows.Automation`). HP: Expo SDK 54, Reanimated, gesture-handler. Tes: `node src/<x>_test.js` (agent), `node src/<x>.test.js` (HP).

**Spec:** `docs/superpowers/specs/2026-11-21-typing-caret-zoom-design.md`

## Global Constraints

- Huruf/zoom di PC tidak pernah diubah; semua zoom adalah kamera HP.
- Caret tidak terbaca → kamera diam. Tidak ada cadangan ke titik klik, kursor, kotak isian, atau diff layar. `typingCam`/`TYPE_SPAN` lama dihapus.
- Default: sakelar "Zoom ikut teks" **nyala**; besar tampilan teks **24 px** (dp di HP).
- Zoom dihitung ulang hanya bila tinggi caret berubah **> 25%**.
- Zoom dibatasi **1x..`MAX_ZOOM` (8)**.
- Tinggi caret wajar: **4..200 px layar PC** (di luar itu: abaikan tinggi, posisi tetap diikuti).
- Zona aman: kamera tidak bergerak selama caret berada di dalam **60% tengah** area pandang (20% margin tiap sisi).
- Polling agent hanya saat ≥ 1 koneksi meminta: Win32 tiap **100 ms**; UIA hanya bila Win32 kosong, paling sering tiap **250 ms**.
- `caretWatch` per koneksi; pesan `caret` hanya ke koneksi yang meminta; dibersihkan saat koneksi tutup.
- HP baru + agent lama: tidak ada pesan `caret` → manual. Agent baru + HP lama: tidak ada `caretWatch` → tidak polling.
- Jangan render ulang React per pesan caret (kamera di shared values; label hanya berubah saat status berganti).

## Protokol

- HP → PC: `{t:"caretWatch", on: boolean}`
- PC → HP: `{t:"caret", x, y, h, on: boolean}` (x,y = kiri-atas caret; x,y,h dinormalisasi ke `monitorFor(ws)`, `on` = caret berada di tampilan itu) atau `{t:"caret", none: true}`.

## Review Focus

- Caret berkedip (rect sama dikirim berulang) → tidak ada pesan duplikat (tes `dedupes identical caret`).
- Alt-Tab ke aplikasi tanpa caret saat mengetik → satu pesan `none`, kamera diam, label "manual" (tes agent `sends none once` + Task 6 step mesin status).
- Caret di monitor lain dari yang ditampilkan (`on:false`) → diperlakukan seperti `none` di HP (tes `caretTarget returns null when off view`).
- Mengetik terus dalam satu baris → kamera tidak bergeser sampai caret keluar zona aman (tes `followCam stays inside safe zone`).
- Proses PowerShell UIA mati/tidak ada → agent tetap jalan dengan Win32 saja, tanpa spam log (tes `uia reader failure is swallowed`).

---

### Task 1: Agent — matematika caret

**Files:**
- Create: `runtime/agent/src/caretmath.js`
- Test: `runtime/agent/src/caretmath_test.js`; tambahkan ke script `test` di `runtime/agent/package.json`

**Interfaces:**
- Produces:
  - `normCaret(rect: {x,y,w,h} | null /* px layar */, mon: {left,top,w,h}) => {x,y,h,on} | {none:true}` — `on` true bila titik tengah caret di dalam mon.
  - `caretKey(msg) => string` — x,y,h dibulatkan 3 desimal; `"none"` untuk none.

- [ ] **Step 1: Tes gagal:** `normCaret(null, mon)` → `{none:true}`; rect `{x:960,y:540,w:2,h:20}` pada mon 1920×1080 di (0,0) → `{x:0.5, y:0.5, h:20/1080, on:true}`; mon kedua `left:1920` → `on:false`; `caretKey` sama untuk rect yang beda < 0.0005.
- [ ] **Step 2:** `node src/caretmath_test.js` → FAIL.
- [ ] **Step 3:** Implementasi.
- [ ] **Step 4:** Lulus.
- [ ] **Step 5: Commit** `feat(agent): caretmath normalisasi caret`

### Task 2: Agent — pembaca caret Win32 + UIA

**Files:**
- Create: `runtime/agent/src/caretread.js`
- Create: `runtime/agent/caret-uia.ps1`

**Interfaces:**
- Produces:
  - `readWin32Caret() => {x,y,w,h} | null` — `GetForegroundWindow` → `GetWindowThreadProcessId` → `GetGUIThreadInfo(tid)`; bila `hwndCaret` dan `rcCaret` tidak kosong, `ClientToScreen` sudut kiri-atas. Struct `GUITHREADINFO` via koffi (pola `input.js`).
  - `createUiaReader({ spawn = child_process.spawn }) => { read(): Promise<{x,y,w,h}|null>, stop(): void }` — satu proses `powershell.exe -NoProfile -ExecutionPolicy Bypass -File caret-uia.ps1` hidup selama ada yang meminta; tiap `read()` menulis `q\n` ke stdin dan menunggu satu baris JSON (timeout 300 ms → null). Proses mati → `read()` mengembalikan null; dihidupkan ulang paling cepat 10 dtk kemudian.
- `caret-uia.ps1`: loop baca stdin; per `q`: `[System.Windows.Automation.AutomationElement]::FocusedElement`, ambil `TextPattern` bila ada, `GetSelection()[0]`; bila `GetBoundingRectangles()` kosong, `Clone()` + `ExpandToEnclosingUnit(Character)` lalu ambil rect pertama dan pakai tepi kirinya (w=1). Tulis `{"x":..,"y":..,"w":..,"h":..}` atau `{}`; semua exception → `{}`.

- [ ] **Step 1:** Implementasi `readWin32Caret` dan uji manual: `node -e "import('./src/caretread.js').then(m=>setInterval(()=>console.log(m.readWin32Caret()),500))"` sambil mengetik di Notepad → rect berubah mengikuti caret; di desktop kosong → null.
- [ ] **Step 2:** Tulis `caret-uia.ps1`; uji manual: jalankan, ketik `q` + Enter sambil fokus di Chrome (kotak alamat atau textarea) → JSON rect; di aplikasi tanpa teks → `{}`.
- [ ] **Step 3:** Implementasi `createUiaReader` (spawn diinjeksikan untuk tes di Task 3).
- [ ] **Step 4: Commit** `feat(agent): pembaca caret Win32 + UI Automation`

### Task 3: Agent — `caretWatch` per koneksi

**Files:**
- Create: `runtime/agent/src/caret.js`
- Test: `runtime/agent/src/caret_test.js` (tambahkan ke script `test`)
- Modify: `runtime/agent/src/index.js` (`handleCommand` tambah `case "caretWatch"`; `ws.on("close")` panggil `caret.drop(ws)`)

**Interfaces:**
- Consumes: `normCaret`, `caretKey` (Task 1); `readWin32Caret`, `createUiaReader` (Task 2); `monitorFor(ws)`, `send(ws,obj)` dari `index.js`.
- Produces: `createCaretWatch({ send, monitorFor, readWin32, uia, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) => { set(ws, on: boolean), drop(ws), tick(): Promise<void> }`. `tick` dipanggil tiap 100 ms selama ada koneksi aktif; timer berhenti dan `uia.stop()` saat tidak ada.

- [ ] **Step 1: Tes gagal** (fake reader & send):
  - `dedupes identical caret`: dua tick dengan rect sama → `send` 1×.
  - `sends none once`: reader null dua tick → satu `{t:"caret",none:true}`.
  - `uses uia only when win32 empty and not more often than 250ms`.
  - `uia reader failure is swallowed`: `uia.read` reject → tick tidak throw, kirim none.
  - `per connection`: ws A on, ws B off → hanya A menerima; `drop(A)` → timer berhenti.
  - `set(ws,true)` mengirim keadaan terkini pada tick berikutnya walau sama dengan koneksi lain (key disimpan per ws).
- [ ] **Step 2:** `node src/caret_test.js` → FAIL.
- [ ] **Step 3:** Implementasi `caret.js`; sambungkan di `index.js` (pola `clipSync`).
- [ ] **Step 4:** `npm test` di `runtime/agent` → semua lulus.
- [ ] **Step 5: Commit** `feat(agent): caretWatch kirim posisi caret ke HP yang meminta`

### Task 4: HP — matematika caret

**Files:**
- Create: `mobile/src/caretmath.js`
- Test: `mobile/src/caretmath.test.js`
- Modify: `mobile/src/camera.js` (hapus `typingCam`, `TYPE_SPAN`), `mobile/src/camera.test.js` (hapus blok tes `typingCam`)

**Interfaces:**
- Produces (semua `"worklet"`-aman tidak diperlukan; dipanggil di JS):
  - `const TEXT_PX_DEFAULT = 24, REZOOM_RATIO = 0.25, SAFE_MARGIN = 0.2, CARET_MIN_PX = 4, CARET_MAX_PX = 200`
  - `caretTarget(msg, monPxH: number) => {x,y,h,validH: boolean} | null` — null untuk `none` atau `on:false`; `validH` = `h*monPxH` dalam `[CARET_MIN_PX, CARET_MAX_PX]`.
  - `zoomForText(textPx, h, fit) => number` — `clamp(textPx / (h * fit.bh), 1, MAX_ZOOM)`.
  - `shouldRezoom(prevH, h) => boolean` — `|h-prevH|/prevH > REZOOM_RATIO` atau `prevH` kosong.
  - `followCam(cur, caret, s, fit, vw, vh) => cam | null` — null bila `s === cur.s` dan caret (pakai `monitorToView`) di dalam zona aman; selain itu `camFor(s, caret.x, caret.y + caret.h/2, ...)`.
  - `textPxFromZoom(s, h, fit) => number` — `s * h * fit.bh`.

- [ ] **Step 1: Tes gagal:** `caretTarget` null untuk none/`on:false`; `validH` false untuk h=1px; `zoomForText(24, 20/1080, fit)` = `24/(20/1080*fit.bh)` dan dibatasi ≤ 8 dan ≥ 1; `shouldRezoom(0.02, 0.022)` false, `(0.02, 0.03)` true; `followCam stays inside safe zone` (caret di tengah → null; caret di tepi → kamera yang menampilkan caret); `textPxFromZoom(zoomForText(t,h,f),h,f) ≈ t` bila tidak terpotong.
- [ ] **Step 2:** `node src/caretmath.test.js` → FAIL.
- [ ] **Step 3:** Implementasi; hapus `typingCam`/`TYPE_SPAN` dari `camera.js` dan tesnya.
- [ ] **Step 4:** `node src/caretmath.test.js` dan `node src/camera.test.js` → lulus (`viewer.js` masih mengimpor `typingCam` — diperbaiki di Task 6; jangan commit build rusak: lakukan Task 4 dan 6 di branch yang sama, commit Task 4 boleh karena tes node lulus, lint dijalankan di Task 6).
- [ ] **Step 5: Commit** `feat(mobile): caretmath zoom dari tinggi caret`

### Task 5: HP — pengaturan dan `caretWatch`

**Files:**
- Modify: `mobile/src/screens/TypeScreen.js` (`pref`, `storePref`, `savePref`, `registerSetting("type")`, UI pengaturan ketik, efek `typing`)
- Modify: `mobile/src/protocol.js` (`msg.caretWatch(on)`)

**Interfaces:**
- Produces: di `TypeScreen.js` ekspor `getCaretPref() => { follow: boolean, textPx: number }`, `setCaretTextPx(px: number)` (simpan + `settingChanged`), `onCaretPref(fn) => unsubscribe`. `pref` bertambah `caretFollow` (default `true`) dan `textPx` (default `TEXT_PX_DEFAULT`, dibatasi 10..80). Keduanya ikut `storePref`, `settingChanged("type", …)`, dan `apply` (validasi tipe).
- Mengirim `msg.caretWatch(true)` saat `typing` jadi true dan `pref.caretFollow`; `caretWatch(false)` saat typing false, sakelar dimatikan, atau unmount. Kirim ulang `true` setelah event `hello` bila masih typing (koneksi pulih).

- [ ] **Step 1:** Tambah `msg.caretWatch` di `protocol.js`.
- [ ] **Step 2:** Perluas `pref` + sinkron; sakelar "Zoom ikut teks" di tempat pengaturan ketik yang sudah ada (pilihan mode/keyboard), keterangan: "Saat mengetik, layar mengikuti teks di PC. Cubit untuk mengatur besar teks."
- [ ] **Step 3:** Efek `caretWatch` seperti di atas.
- [ ] **Step 4:** `cd mobile && npx expo lint` → tanpa error baru.
- [ ] **Step 5: Commit** `feat(mobile): pengaturan Zoom ikut teks + caretWatch`

### Task 6: HP — viewer mengikuti caret

**Files:**
- Modify: `mobile/src/viewer.js` (`focusTyping`, `noteTypePoint`, listener koneksi, `pinchG.onEnd`, `panG.onStart`, efek `typing`, label status)

**Interfaces:**
- Consumes: Task 4 (`caretTarget`, `zoomForText`, `shouldRezoom`, `followCam`, `textPxFromZoom`, `CARET_*`), Task 5 (`getCaretPref`, `setCaretTextPx`, `onCaretPref`).

Mesin status (ref, bukan state React kecuali label): `follow` (bool), `lastCaret`, `lastH`, `zoomS`.
- Masuk typing: `follow = pref.follow`; simpan kamera lama (perilaku `typeSavedCam` dipertahankan); tidak bergerak sampai pesan `caret` pertama.
- Pesan `caret` (hanya saat typing && follow && `current !== "cam"`): `t = caretTarget(msg, monPxH)`; null → diam. Bila `t.validH && shouldRezoom(lastH, t.h)` → `zoomS = zoomForText(textPx, t.h, fit)`, `lastH = t.h`. Lalu `followCam(cam, t, zoomS ?? cam.s, …)` → `animateCamTo` bila bukan null.
- `panG.onStart` (Look satu jari) dan pan dua jari di Click saat typing → `runOnJS(goManual)()`: `follow = false`.
- `pinchG.onEnd` saat typing && follow && `lastCaret.validH` → `setCaretTextPx(textPxFromZoom(cam.s, lastH, fit))`, `zoomS = cam.s`; follow tetap. Bila tidak valid → hanya zoom biasa.
- Klik dari HP ini (`noteTypePoint`: tap, drag end, reticle) saat typing → `follow = pref.follow`; tidak lagi memanggil `focusTyping`. Hapus `focusTyping` versi lama dan impor `typingCam`.
- `monPxH` = tinggi px monitor yang ditampilkan (dari daftar `monitors`; untuk "all" tinggi gabungan) — dipakai untuk `validH`.
- Label kecil pojok kanan atas viewer saat typing: "ikut caret" (follow dan caret terakhir valid) atau "manual"; tidak tampil bila sakelar mati. Re-render hanya saat teks label berubah.
- Sakelar mati → tidak ada zoom otomatis sama sekali saat typing (kamera tetap), keluar typing tetap memulihkan kamera lama.

- [ ] **Step 1:** Implementasi sesuai daftar di atas.
- [ ] **Step 2:** `cd mobile && npx expo lint` dan semua `node src/*.test.js` → lulus.
- [ ] **Step 3: Uji manual** (agent baru + build dev): Notepad — ketik, kamera mengikuti dan diam selama di tengah; ganti ukuran font Notepad besar → zoom mengecil; Chrome textarea — mengikuti; desktop/game tanpa caret → label "manual", kamera diam; geser satu jari → manual, tap di PC → ikut lagi; cubit → teks lebih besar, tetap ikut, nilai tersimpan setelah tutup/buka mode ketik; tampilan "Semua" → mengikuti; sakelar mati → tidak ada zoom otomatis.
- [ ] **Step 4: Commit** `feat(mobile): viewer mengikuti caret saat mengetik`
