# Vena — panduan pemasangan (versi sederhana)

- Masuk dengan: **saidrezairfansyahputra@gmail.com**
- File tersimpan di: Google Drive akun yang sama, folder **"Vena Drive"**
- Aplikasi hanya bisa melihat file yang diunggah lewat vena.web.id
  (izin `drive.file`). Isi Drive yang lain tidak terjangkau.

Google Cloud (project, Drive API, OAuth consent, Client ID) sudah selesai,
dan `config.js` sudah terisi. Tinggal 2 langkah.

## 1. Pastikan test user

Google Cloud Console → **Google Auth Platform → Audience** → bagian
**Test users** → harus ada `saidrezairfansyahputra@gmail.com`.
Kalau belum: **Add users** → isi email → **Save**.
Biarkan status aplikasi **Testing** (jangan klik Publish app).
Dengan begitu Google hanya mengizinkan email di daftar ini untuk masuk.

## 2. Unggah ke GitHub

Login GitHub dengan akun admin.vena → buka repositori vena.web.id →
hapus file lama → **Add file → Upload files** → seret semua isi folder
`private-main` → **Commit changes**. Tunggu 1–2 menit.

## Cara masuk

1. Buka https://vena.web.id → **Masuk dengan Google**.
2. Jendela Google terbuka → ketik email dan **password** akun saidreza
   (plus kode Verifikasi 2 Langkah di HP).
3. Pertama kali saja: muncul "Google belum memverifikasi aplikasi ini" →
   **Lanjutkan**, lalu izinkan akses Google Drive.

Kalau browser sudah login Google dengan akun itu, cukup satu klik
"Lanjutkan sebagai …" tanpa mengetik password lagi. Sesi bertahan ±1 jam;
setelah itu klik **Sambungkan lagi**.

## Keamanan (pengganti rules Firebase)

- Google hanya mengizinkan akun di daftar **Test users** untuk masuk.
- Aplikasi juga menolak akun selain yang tertulis di `config.js`.
- Password tidak pernah melewati website Anda; diketik di jendela Google.

## Data lama

Aplikasi kalkulator (Firebase) tidak dipakai lagi. Kunci Firestore-nya:
Firebase Console (akun admin.vena) → Firestore Database → Rules →

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

→ **Publish**.
