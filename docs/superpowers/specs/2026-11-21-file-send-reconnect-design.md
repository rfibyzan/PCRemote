# Kirim file HP → PC tahan koneksi putus saat memilih file — rancangan singkat

Tanggal: 2026-11-21 · Status: draf

**Masalah.** Saat pemilih file terbuka, PCRemote pindah ke latar belakang dan
Android menahan koneksinya. Setelah file dipilih, `pickAndSend` langsung
memanggil `sendOne` (`mobile/src/filexfer.js:110`) padahal koneksi ulang belum
selesai, sehingga gagal "tidak tersambung ke PC".

**Tujuan.** Memilih file selama apa pun tidak membuat pengiriman gagal, selama
koneksi bisa pulih.

**Pendekatan.** Satu-satunya yang masuk akal: setelah picker kembali, tunggu
status `connected` (dari `connection.js`) sampai batas waktu (±15 dtk) sebelum
`fileStart`. File langsung tampil di panel transfer dengan status "menunggu
koneksi…". Habis waktu → gagal dengan pesan jelas. Alternatif (menjaga socket
tetap hidup di latar belakang) ditolak: Android tidak menjamin, butuh layanan
foreground.

**Juga.** Bila koneksi putus di tengah kiriman beberapa file, file berikutnya
ikut menunggu koneksi lagi, bukan langsung gagal semua.

**Bukan tujuan.** Melanjutkan file yang terputus di tengah (resume) — tetap
gagal dan perlu dikirim ulang.
