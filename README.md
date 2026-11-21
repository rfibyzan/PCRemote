# PC Remote

Kontrol PC Windows dari HP Android, lewat Wi-Fi rumah atau data seluler:
layar PC di HP, mouse dan keyboard, gamepad (ViGEm), clipboard, webcam,
media keys, multi-monitor, dan stream satu jendela.

Panduan di bawah untuk **pemakai**: dari unduh sampai bisa dipakai.
Bagian **Untuk developer** ada di paling bawah.

---

## 1. Yang dibutuhkan

| | |
|---|---|
| PC | Windows 10 atau 11 (64-bit), akun dengan hak admin |
| HP | Android |
| Jaringan | Wi-Fi yang sama dengan PC (paling cepat), atau data seluler |
| Gamepad (opsional) | Driver [ViGEmBus](https://github.com/ViGEm/ViGEmBus/releases) terpasang di PC |

## 2. Unduh

**Cara A: paket siap pakai (disarankan).**
Buka [Releases](https://github.com/rfibyzan/PCRemote/releases/latest) lalu unduh
dua file ini:

| File | Untuk | Isi |
|---|---|---|
| `PCRemote-vX.Y.Z-windows.zip` | PC | `PCRemote.exe`, `HOW-TO.txt`, dan folder `runtime` (berisi `node.exe`, `ffmpeg.exe` minimal, agent + dependensinya). `cloudflared.exe` diunduh otomatis saat start pertama. |
| `PCRemote-vX.Y.Z.apk` | HP | Aplikasi Android (tidak lagi ikut di zip PC) |

Tidak perlu memasang Node.js atau apa pun lagi.

**Cara B: dari kode sumber** (kalau belum ada rilis).
1. Di halaman repo klik **Code › Download ZIP**.
2. Unduh tiga file ini dan taruh di folder `runtime\`:

   | File | Sumber |
   |---|---|
   | `runtime\node.exe` | [Node.js LTS](https://nodejs.org) (`node.exe` Windows x64) |
   | `runtime\ffmpeg.exe` | [ffmpeg full build](https://www.gyan.dev/ffmpeg/builds/) (ambil `bin\ffmpeg.exe`) |
   | `runtime\cloudflared.exe` | [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (Windows amd64, ganti nama jadi `cloudflared.exe`) |

3. Pasang [Node.js LTS](https://nodejs.org) di PC (untuk `npm`), lalu di Command Prompt:
   ```bat
   cd <folder PCRemote>\runtime\agent
   npm install
   ```
4. APK untuk HP: `PCRemote.apk` di folder utama (build rilis terbaru).

## 3. Ekstrak

1. Klik kanan file zip › **Extract All…** ke folder tetap, misalnya `C:\Tools\PCRemote`.
2. Jangan menjalankan dari dalam zip, dan jangan memindahkan `PCRemote.exe` sendirian:
   `PCRemote.exe` harus selalu satu folder dengan folder `runtime`.

Isi folder yang benar:

```
PCRemote\
├── PCRemote.exe
├── HOW-TO.txt
├── PCRemote.apk
└── runtime\
    ├── node.exe
    ├── ffmpeg.exe
    ├── cloudflared.exe
    └── agent\
```

## 4. Jalankan di PC

1. Klik dua kali **`PCRemote.exe`**, lalu pilih **Yes** pada prompt admin (UAC).
2. Jika muncul *Windows protected your PC*: klik **More info › Run anyway**.
3. Jika Windows Firewall bertanya, pilih **Allow** (PC Remote juga menambahkan aturan firewall sendiri).
4. Ikon PC Remote muncul di tray (dekat jam; cek panah ^ ikon tersembunyi).
   Klik ikonnya (atau klik kanan › **Open dashboard**) untuk membuka dashboard di browser.

Dashboard menampilkan **Kode pairing** dan QR di bagian **Pasangkan HP**.

## 5. Pasang aplikasi di HP

1. Salin file APK (`PCRemote-vX.Y.Z.apk` dari Releases, atau `PCRemote.apk` di folder) ke HP (kabel, Drive, atau chat ke diri sendiri), lalu buka.
2. Izinkan **Install unknown apps** untuk aplikasi yang membuka APK itu (cukup sekali).
3. Buka **PC Remote**.

## 6. Pasangkan HP dengan PC (sekali saja)

Pilih salah satu:
- Di aplikasi ketuk **Scan QR di layar PC**, arahkan ke QR di dashboard; atau
- scan QR dashboard dengan kamera bawaan HP (langsung membuka aplikasi); atau
- ketik kode pairing dari dashboard (format seperti `ABCD 2345`).

Setelah itu HP tersambung otomatis setiap kali. Kode tetap sama walau PC restart.
HP yang terhubung terlihat di dashboard (**HP terhubung**), dengan tombol **Putuskan** dan **Blokir**.

## 7. Memakai aplikasi

| Tab | Fungsi |
|---|---|
| **PAD** | Layar PC di HP + mouse. Mode sentuh **Click / Look / Bar**, preset kualitas Low / Mid / High |
| **TYPE** | Keyboard: ketik teks atau **Ketik langsung** (tombol asli, kombinasi Ctrl/Alt/Shift/Win) |
| **GAME** | Gamepad virtual di atas layar PC (butuh ViGEmBus) |
| **WIN** | Kelola jendela: tombol **Jendela** membuka bar thumbnail (tap = fokus, tahan = Stream / Minimize / Maksimalkan / Tutup) dan **+ Aplikasi** untuk membuka aplikasi PC. Seksi **Pintasan** berisi tombol shortcut buatan sendiri |

**Pintasan sendiri (WIN › Pintasan).** Tekan **+ Tambah**, beri nama (mis. *Listary*), nyalakan
**Ctrl / Shift / Alt / Win** yang dibutuhkan, pilih satu tombol utama (huruf, angka, simbol, F1–F12, Enter, panah, …),
coba dengan **Tes kirim**, lalu **Simpan**. Sesudah itu cukup tap tombolnya, mis. *Listary* = `Ctrl+Shift+Alt+/`.
Tahan tombol pintasan untuk **Edit / Geser kiri / Geser kanan / Hapus**.

**Pengaturan disimpan juga di PC.** Agent versi baru menyimpan salinan pengaturan HP di
`%APPDATA%\PCRemote\settings.json`: pintasan, layout gamepad, kualitas stream, mode video (H.264/JPEG),
pengaturan TYPE, scrollbar, serta sematan & riwayat aplikasi. Setelah aplikasi dihapus/diinstal ulang,
cukup pairing lagi dan semuanya kembali otomatis. Yang paling baru diubah yang dipakai.
Kode kunci, daftar PC, dan ID HP tetap hanya di HP.

Preset kualitas: Low 2 Mbps/30 fps/720p, Mid 5 Mbps/30 fps/1080p, High 10 Mbps/60 fps/1080p.

**Wi-Fi vs data seluler.** Saat satu Wi-Fi dengan PC, aplikasi otomatis memakai jalur lokal (paling cepat).
Di luar rumah, koneksi lewat tunnel Cloudflare terenkripsi dan dibatasi sekitar 2,5 Mbps.
Pada beberapa operator, alamat tunnel baru butuh beberapa menit sebelum bisa dijangkau; tunggu sebentar lalu **Coba lagi sekarang**.

## 8. Mulai otomatis bersama Windows (opsional)

Dashboard › **Mulai otomatis** › nyalakan **Jalankan PC Remote saat Windows menyala**.
Tidak ada prompt UAC saat login, dan muncul juga di Task Manager › Startup.

## 9. Menutup dan memperbarui

- **Menutup:** klik kanan ikon tray › **Close PC Remote**.
- **Memperbarui:** ekstrak versi baru (boleh menimpa folder lama), lalu jalankan `PCRemote.exe` lagi.
  PC Remote yang lama otomatis ditutup dan diganti. Versi rilis menampilkan banner di dashboard bila ada versi baru.

## 10. Kalau ada masalah

| Gejala | Coba |
|---|---|
| *Keep PCRemote.exe in the same folder as the runtime folder* | Ekstrak ulang seluruh zip; jangan pindahkan exe sendirian |
| HP tidak bisa tersambung | Pastikan PC Remote jalan (ikon tray ada), izinkan di firewall, cek Wi-Fi/data HP, lalu **Coba lagi sekarang** |
| HP bilang *Agent di PC masih versi lama* | Tutup PC Remote dari tray, lalu jalankan `PCRemote.exe` versi terbaru |
| Gamepad tidak terdeteksi game | Pasang [ViGEmBus](https://github.com/ViGEm/ViGEmBus/releases), lalu jalankan ulang PC Remote |
| Webcam tidak tampil | Windows Settings › Privacy › Camera › izinkan aplikasi desktop |
| Maksimalkan / Jalankan sebagai admin tidak jalan | Setujui prompt UAC yang muncul di PC |
| HP lama/hilang | Dashboard › **Keamanan** › **Buat kode kunci baru** (semua HP harus pairing ulang) |

Detail kejadian ada di **Log koneksi** (di aplikasi dan di dashboard).

---

## Untuk developer

```
PCRemote/
├── mobile/          # Expo / React Native Android app (Expo SDK 54)
│   └── src/         # screens, viewer, connection, protocol, gamepad
├── runtime/
│   ├── agent/       # Node.js PC agent (src/) — input, capture, tunnel
│   ├── cloudflared.exe / node.exe / ffmpeg.exe  # NOT in git, see below
│   └── agent/ViGEmClient.dll
├── launcher/        # PCRemote.exe source (.NET Framework, C# 5)
├── PCRemote.apk     # latest release build (local gradle), attached to Releases
└── HOW-TO.txt       # short end-user setup
```

### Releases

The easiest way: grab `PCRemote-vX.Y.Z-windows.zip` from
[GitHub Releases](https://github.com/rfibyzan/PCRemote/releases/latest), unzip, run `PCRemote.exe`. The launcher source is in `launcher/` (rebuild it on Windows with `launcher\build.bat`; CI and releases compile it too).
It already contains node.exe, ffmpeg.exe and cloudflared.exe. A release build checks for a newer
release and shows a banner on the PC dashboard.

To publish one: `git tag v1.2.0 && git push origin v1.2.0` (or Actions → Release → Run workflow).
`.github/workflows/release.yml` builds the zip; with the `EXPO_TOKEN` repo secret it also attaches the
preview APK instead of the committed `PCRemote.apk` (built without the gitignored SF Pro files, so it uses Roboto).

### Required binaries (not committed — too large for GitHub)

Place these next to `runtime/` as in a release folder:

| File | Where to get it |
|---|---|
| `runtime/node.exe` | Node.js LTS (https://nodejs.org) |
| `runtime/ffmpeg.exe` | Minimal build: `bash tools/ffmpeg/build.sh` (mingw-w64), or any full build (https://www.gyan.dev/ffmpeg/builds/) |
| `runtime/cloudflared.exe` | Optional: the agent downloads it on first start. Manual: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |

`ViGEmClient.dll` ships in `runtime/agent/` (MIT, see `ViGEmClient.LICENSE.txt`);
install [ViGEmBus](https://github.com/ViGEm/ViGEmBus) on the PC for gamepad support.

### Run the PC agent

```bat
cd runtime\agent
npm install
npm start
```

Open the tray icon → dashboard shows the pair code. Tests: `npm test`
(unit 37 + live selftest against a running agent).

### Run the mobile app

```bash
cd mobile
npm install
npx expo start --dev-client   # needs a dev build on the phone
```

Build an APK: `npx eas-cli build --profile preview --platform android`
(EAS account required). Lint: `npx expo lint`.

### Tes perubahan sebagai developer (tanpa build ulang)

Perubahan yang hanya JavaScript (seperti fitur Pintasan + sinkron pengaturan) **tidak perlu build ulang**
dev client, karena tidak ada modul native baru. Cukup:

1. PC: `git pull`, tutup PC Remote dari tray, lalu jalankan lagi agent terbaru
   (`cd runtime\agent && npm install && npm start`, atau `PCRemote.exe` dari folder repo).
2. HP + PC di Wi-Fi yang sama, lalu di PC:
   ```bat
   cd mobile
   npm install
   npx expo start --dev-client --lan --clear
   ```
3. Buka aplikasi **PC Remote (dev)** di HP → pilih server Metro (atau scan QR-nya).
   Izinkan port 8081 di Windows Firewall bila HP tidak menemukan server.

Build ulang dev client (`eas build --profile development --platform android`, atau lokal seperti di bawah dengan
`APP_VARIANT=development`) **hanya** perlu bila ada perubahan native: paket native baru, `app.json`/`app.config.js`
plugin, atau `mobile/modules/*`.

Catatan: varian dev (`com.hyte70.pcremote.dev`) dan rilis (`com.hyte70.pcremote`) punya penyimpanan sendiri-sendiri,
tetapi keduanya membaca pengaturan dari agent PC yang sama.

### Build APK rilis penuh di PC (tanpa kuota EAS)

Butuh: Node.js 22, JDK 17, Android SDK (lewat Android Studio, set `ANDROID_HOME`).

```bat
cd mobile
npm install
npx expo prebuild --platform android --clean
cd android
.\gradlew assembleRelease   # PowerShell; di cmd cukup: gradlew assembleRelease
```

Hasilnya `mobile\android\app\build\outputs\apk\release\app-release.apk`. Sebelum build, naikkan
`version` dan `versionCode` di `mobile/app.json` (supaya bisa diinstal menimpa versi lama tanpa menghapus data).

### Merilis ke GitHub

1. Salin `app-release.apk` ke root repo sebagai `PCRemote.apk` (menimpa yang lama).
2. Commit lewat branch + PR seperti biasa, lalu merge ke `main`.
3. Buat tag versi: `git tag v1.1.0 && git push origin v1.1.0`.
4. Workflow **Release** membuat GitHub Release berisi `PCRemote-v1.1.0-windows.zip`
   (PCRemote.exe + runtime + agent + APK) dan `PCRemote-v1.1.0.apk` terpisah.
   Bila secret `EXPO_TOKEN` ada dan kuota EAS tersedia, APK EAS dipakai menggantikan `PCRemote.apk`.

### Pairing

On the PC tray dashboard read the code once, enter it in the phone app.
Same Wi-Fi or mobile data both work. The code survives restarts
(`revoke` on the dashboard mints a new one and kicks paired phones).

### Start with Windows

Dashboard → **Mulai otomatis** toggle. It creates a Task Scheduler task
`PCRemote` (no trigger, highest privileges, so no UAC prompt) plus an
`HKCU\…\Run` value `PC Remote` that runs `schtasks /run /tn "PCRemote"` at
log-on. That entry shows in Task Manager › Startup; disabling it there turns
the dashboard toggle off too. Turning the toggle off removes the Run value,
its StartupApproved flag and the task.
The Run value points at `runtime\agent\autostart\PCRemoteStart.exe`, a tiny non-elevated helper (built on first use from `PCRemoteStart.cs` with the .NET Framework `csc.exe` Windows already has) that starts the task hidden, so Task Manager lists it as **PC Remote** with our icon; if it can't be built, the Run value falls back to `schtasks.exe` directly.
