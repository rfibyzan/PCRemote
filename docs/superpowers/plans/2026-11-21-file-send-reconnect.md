# Kirim File Tahan Putus Koneksi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setelah memilih file (selama apa pun), HP menunggu koneksi ke PC pulih sebelum mengirim, bukan langsung gagal.

**Architecture:** Helper murni `waitUntil` (dapat diuji dengan node) dipakai `filexfer.js` untuk menunggu event `hello` dari `connection.js` sebelum `fileStart`. Baris transfer dibuat lebih dulu dengan status `"waiting"`; panel menampilkan "menunggu koneksi…".

**Tech Stack:** Expo SDK 54 / React Native, JS murni; tes = `node src/<x>.test.js` (pola `ok(cond, name)` seperti `camera.test.js`).

**Spec:** `docs/superpowers/specs/2026-11-21-file-send-reconnect-design.md`

## Global Constraints

- Batas tunggu koneksi: **15000 ms** (`CONNECT_WAIT_MS`).
- Tidak ada resume file yang putus di tengah — tetap gagal.
- Tidak menambah dependensi native (tidak perlu build baru selain JS).
- Teks UI berbahasa Indonesia, gaya yang sudah ada.

## Review Focus

- Koneksi sudah tersambung saat picker kembali → kirim langsung tanpa jeda (tes `resolves at once when ready`).
- Koneksi tidak pernah pulih → gagal tepat setelah 15 dtk dengan pesan "PC belum tersambung lagi" dan listener dilepas (tes `rejects after timeout and unsubscribes`).
- Koneksi putus di tengah antrean beberapa file → file berikutnya menunggu lagi, bukan langsung gagal (Task 2 step 3: `sendOne` selalu menunggu sebelum `fileStart`).
- Event `close` datang saat masih menunggu → tetap menunggu (bukan gagal), karena reconnect otomatis sedang berjalan (tes `ignores unrelated events`).
- Baris "menunggu" bisa ditutup (✕)? Tidak — `dismissTransfer` harus memperlakukan `"waiting"` seperti aktif.

---

### Task 1: Helper `waitUntil`

**Files:**
- Create: `mobile/src/waituntil.js`
- Test: `mobile/src/waituntil.test.js`

**Interfaces:**
- Produces: `waitUntil({ isReady: () => boolean, subscribe: (onEvent: (ev) => void) => (() => void), match: (ev) => boolean, timeoutMs: number, timeoutMessage: string }) => Promise<void>` — resolve segera bila `isReady()`; selain itu resolve pada event pertama yang `match`, reject `Error(timeoutMessage)` setelah `timeoutMs`; selalu memanggil fungsi unsubscribe dan membersihkan timer.

- [ ] **Step 1: Tulis tes gagal** (fake `subscribe` yang menyimpan callback; timeout kecil, mis. 30 ms)
  - `resolves at once when ready`: `isReady=()=>true` → resolve, `subscribe` tidak dipanggil.
  - `resolves on matching event`: panggil callback dengan `{t:"hello"}` → resolve; unsubscribe terpanggil 1×.
  - `ignores unrelated events`: callback `{t:"close"}` lalu `{t:"hello"}` → resolve setelah `hello`.
  - `rejects after timeout and unsubscribes`: tanpa event → reject dengan pesan persis `timeoutMessage`; unsubscribe terpanggil 1×.
  Akhiri file dengan `console.log(pass/total)` dan `process.exit(1)` bila gagal (tes async: jalankan berurutan dalam `async main()`).
- [ ] **Step 2:** `node mobile/src/waituntil.test.js` → FAIL (modul tidak ada).
- [ ] **Step 3:** Implementasikan `waitUntil` di `mobile/src/waituntil.js` (ES module, tanpa impor RN).
- [ ] **Step 4:** `node mobile/src/waituntil.test.js` → `4/4 passed`.
- [ ] **Step 5: Commit** `feat(mobile): waitUntil helper untuk menunggu koneksi`

### Task 2: Kirim file menunggu koneksi

**Files:**
- Modify: `mobile/src/filexfer.js` (`sendOne`, `pickAndSend`, `dismissTransfer`)
- Modify: `mobile/src/transferpanel.js` (`Row`)

**Interfaces:**
- Consumes: `waitUntil` (Task 1); `addListener`, `getStatus` dari `connection.js` (event `{t:"hello"}` = tersambung lagi).

- [ ] **Step 1:** Di `filexfer.js` tambah `const CONNECT_WAIT_MS = 15000;` dan fungsi lokal `waitConnected()` = `waitUntil({ isReady: () => getStatus().connected, subscribe: addListener, match: (e) => e.t === "hello", timeoutMs: CONNECT_WAIT_MS, timeoutMessage: "PC belum tersambung lagi, coba kirim ulang" })`.
- [ ] **Step 2:** `sendOne`: buat baris dengan `status: getStatus().connected ? "sending" : "waiting"`; sebelum `send fileStart`, `await waitConnected()` lalu `patch(id, { status: "sending" })`. Error dari tunggu masuk ke `catch` yang sudah ada (jangan kirim `fileCancel` bila `fileStart` belum pernah terkirim — tambahkan flag `started`).
- [ ] **Step 3:** `pickAndSend`: tetap berurutan; karena tiap `sendOne` menunggu sendiri, antrean setelah putus otomatis menunggu. Tambahkan semua aset ke panel lebih dulu? **Tidak** — cukup berurutan (YAGNI).
- [ ] **Step 4:** `dismissTransfer`: anggap `"waiting"` aktif (tidak bisa dihapus). `transferpanel.js` `Row`: `active` mencakup `"waiting"`; teks baris untuk `"waiting"` = `"Menunggu koneksi ke PC…"`; progress bar tidak tampil saat waiting.
- [ ] **Step 5: Verifikasi** `cd mobile && npx expo lint` → tanpa error baru; `node src/waituntil.test.js` → lulus.
- [ ] **Step 6: Uji manual di HP** (build dev): buka "Kirim file ke PC", diamkan picker ≥ 60 dtk, pilih file → baris "Menunggu koneksi ke PC…" lalu terkirim. Matikan agent PC lalu pilih file → gagal setelah ±15 dtk dengan pesan di atas.
- [ ] **Step 7: Commit** `fix(mobile): kirim file menunggu koneksi pulih setelah memilih file`
