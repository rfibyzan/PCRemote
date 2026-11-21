# Zoom ikut caret saat mengetik — rancangan

Tanggal: 2026-11-21 · Status: draf, menunggu persetujuan

## Maksud dan alasan

Di mode ketik langsung (TYPE, keyboard HP terbuka), viewer saat ini zoom ke
titik klik terakhir atau ke kursor mouse PC (`viewer.js` `focusTyping`,
`camera.js` `typingCam`) dengan zoom tetap (`TYPE_SPAN = 0.45`). Pengguna
merasa ini tidak nyaman dan kadang rusak: titik klik/kursor sering bukan
tempat teks muncul, dan zoom tidak bisa diatur.

Yang diinginkan: begitu mengetik, layar langsung menampilkan teks yang sedang
diketik, dengan besar tampilan yang nyaman, dan bisa dimatikan.

## Tujuan

- Kamera mengikuti **caret** (posisi teks muncul) di PC selama mode ketik.
- Zoom dihitung dari **tinggi caret**, sehingga teks terlihat sama besar di HP
  apa pun ukuran aslinya di PC (teks besar tidak overzoom).
- Pengguna mengatur **besar tampilan teks di HP** (seberapa besar teks
  terlihat di layar HP), bukan level zoom; nilainya disimpan. Huruf di PC
  tidak pernah diubah — ini murni zoom kamera di HP.
- Sakelar di pengaturan ketik untuk **mematikan** ikut caret.
- Geser manual selalu menang atas ikut otomatis.

## Bukan tujuan / sengaja tidak dibuat

- Tidak menebak posisi teks bila caret tidak terbaca: tidak zoom ke kotak
  isian, tidak membandingkan perubahan layar, tidak lompat ke titik klik atau
  kursor. Bila caret tidak ada → kamera diam, pengguna mengatur manual.
- Tidak mengubah perilaku zoom di luar mode ketik.
- Tidak mengubah apa pun di PC (ukuran huruf, zoom aplikasi).

## Anti-tujuan (gagal walau "jalan")

- Layar goyang/berdenyut selama mengetik dalam satu baris.
- Kamera menarik balik setelah pengguna menggeser manual.
- Polling caret membebani PC atau koneksi saat tidak sedang mengetik.

## Pendekatan yang dipertimbangkan

1. **Kamera ikut caret dari PC** — dipilih. Agent membaca caret, HP mengarahkan
   kamera. Paling sesuai dengan keinginan "langsung ke teks yang diketik".
2. Kaca pembesar (strip perbesaran di atas keyboard, layar tetap utuh) —
   ditolak: memakan ruang yang sudah sempit, tetap butuh caret.
3. Tanpa zoom otomatis, hanya ingat posisi/zoom terakhir — ditolak: tidak
   menjawab keinginan.

Untuk mitigasi aplikasi yang tidak mendukung, opsi tebakan (kotak isian aktif,
perubahan layar, titik klik) dibahas dan **ditolak pengguna**: cukup menyerah
dan beri kendali manual.

## Perilaku yang diputuskan

### PC (agent)

- Hanya aktif untuk HP yang meminta: HP mengirim
  `{t:"caretWatch", on:true|false}` saat mode ketik menyala/mati (dan fitur
  tidak dimatikan). Status ini **per koneksi HP**; polling berjalan selama
  minimal satu HP memintanya, dan pesan `caret` hanya dikirim ke HP yang
  meminta. Mati otomatis saat koneksi HP itu putus. *(keputusan Claude)*
- Membaca caret beberapa kali per detik dari jendela foreground, berurutan:
  1. Win32 `GetGUIThreadInfo` (`rcCaret` + `ClientToScreen`) lewat `koffi`
     (sudah dipakai di `input.js`). Untuk Notepad, dialog, aplikasi Win32.
  2. UI Automation (caret/seleksi `TextPattern` pada elemen fokus) untuk
     Chrome, Edge, Office, VS Code/Electron. Dijalankan di proses pembantu
     (UIA sulit dari Node langsung) — bentuk prosesnya diserahkan ke builder.
- Mengirim ke HP hanya bila berubah: `{t:"caret", mon, x, y, h}` dengan x/y/h
  dinormalisasi terhadap monitor tempat caret berada (konsisten dengan
  koordinat monitor yang dipakai viewer), atau `{t:"caret", none:true}` bila
  tidak terbaca.

### HP (viewer)

- **Caret terbaca:** kamera menuju caret.
  - Zoom = besar tampilan teks target (px di HP) ÷ tinggi caret di layar HP
    pada 1x, dibatasi 1x..`MAX_ZOOM`.
  - Zoom dihitung ulang hanya bila tinggi caret berubah > ~25% (pindah dari
    judul ke paragraf); selain itu zoom tetap.
  - Kamera hanya bergeser bila caret mendekati tepi area pandang (zona aman di
    tengah); lalu caret dibawa kembali ke dalam. Semua gerakan dianimasikan.
  - Tinggi caret di luar kisaran wajar (mis. 1 px, atau lebih tinggi dari
    sebagian besar layar) → abaikan tinggi, pakai zoom terakhir; posisi tetap
    diikuti.
- **Caret tidak terbaca:** kamera diam (tidak lompat ke klik/kursor).
- **Caret di monitor yang tidak sedang ditampilkan:** diperlakukan seperti
  tidak terbaca (tidak berpindah monitor otomatis). Di tampilan **"Semua"**
  monitor, caret dipetakan ke tata letak gabungan dan tetap diikuti.
  *(keputusan Claude)*
- **Cubit saat mengetik (diputuskan pengguna):** mengubah besar tampilan teks
  target dan menyimpannya; kamera **tetap ikut caret** dengan zoom baru.
  Nilai baru = besar teks di HP pada akhir cubitan (zoom akhir × tinggi caret
  terakhir yang valid). Bila caret sedang tidak terbaca atau tingginya tidak
  wajar, cubit hanya zoom biasa dan nilai tersimpan tidak berubah.
- **Geser = manual:** menggeser kamera (satu jari di Look, dua jari di Click)
  saat mengetik → berhenti ikut caret. Ikut lagi bila pengguna klik **dari HP
  ini** (tap, drag mouse satu jari di Click, klik reticle) atau membuka ulang
  mode ketik. Klik mouse fisik di PC atau dari HP lain tidak dihitung.
  *(keputusan Claude)*
- **Label kecil** di pojok viewer: "ikut caret" atau "manual".
- Saat keluar dari mode ketik, kamera kembali ke posisi sebelum mengetik
  (perilaku sekarang, `unfocusTyping`, dipertahankan).
- Sumber `cam` (webcam) dan stream satu jendela: fitur tidak aktif / perilaku
  diserahkan ke builder asalkan tidak merusak yang ada.

### Pengaturan

- Di pengaturan ketik (pref `type` di `TypeScreen.js`, sudah disinkronkan
  lewat `settingsync`): sakelar **"Zoom ikut teks"** (default nyala) dan nilai
  besar tampilan teks di HP (diatur lewat cubit; default ±24 px, angka pasti
  diserahkan ke builder).
- Sakelar mati → mode ketik tidak zoom otomatis sama sekali dan agent tidak
  diminta membaca caret. Bagian `typingCam` lama (zoom ke klik/kursor)
  dihapus, tidak dijadikan cadangan.

## Batasan

- Agent: Node + `koffi`, Windows. HP: Expo/React Native, kamera berjalan di UI
  thread (Reanimated); jangan render ulang per pesan caret.
- Kompatibilitas versi: HP baru dengan agent lama (tidak kenal `caretWatch`)
  → tidak ada pesan `caret`, perlakukan sebagai tidak terbaca (manual).
- Beban: polling hanya saat mode ketik aktif; pesan hanya saat berubah.

## Diserahkan ke builder

- Bentuk proses pembantu UIA (PowerShell, exe C# kecil di `launcher/`, dll.)
  dan frekuensi polling yang tepat.
- Angka pasti: besar tampilan teks default, lebar zona aman, ambang 25%,
  kisaran tinggi caret yang wajar.
- Letak dan gaya label status serta sakelar di UI pengaturan ketik.
