# Vena — masuk dengan password

Setelah pengaturan ini, buka **vena.web.id** di komputer atau HP mana pun,
ketik password, dan langsung masuk. Tidak perlu akun Google dan tidak perlu HP.

File tetap tersimpan di Google Drive **saidrezairfansyahputra@gmail.com**,
di folder **"Vena Drive"**. Aplikasi hanya bisa membuka file yang diunggah
lewat Vena; isi Drive yang lain tidak terjangkau.

---

## Pengaturan sekali saja (±7 menit)

Semua langkah dilakukan dengan akun **saidrezairfansyahputra@gmail.com**.

### A. Buat server login

1. Buka **https://script.google.com** → klik **New project**.
2. Klik tulisan **Untitled project** di kiri atas → ganti jadi `Vena` → Rename.
3. Klik ikon **roda gigi (Project Settings)** di menu kiri → centang
   **Show "appsscript.json" manifest file in editor**.
4. Masih di halaman itu, gulir ke **Script Properties** → **Add script property**:
   - Property: `APP_PASSWORD`
   - Value: password pilihan Anda (**minimal 8 karakter**, gabungkan huruf dan angka)
   → **Save script properties**.
5. Klik ikon **< > (Editor)** di menu kiri.
   - Klik file **appsscript.json** → hapus semua isinya → tempel isi file
     `server/appsscript.json` dari zip → **Save** (Ctrl+S).
   - Klik file **Code.gs** → hapus semua isinya → tempel isi file
     `server/Code.gs` dari zip → **Save** (Ctrl+S).

### B. Beri izin & cek

6. Di bagian atas editor, pilih fungsi **cekPengaturan** → klik **▶ Run**.
7. Muncul "Authorization required" → **Review permissions** → pilih akun
   saidreza → muncul "Google hasn't verified this app" → klik **Advanced** →
   **Go to Vena (unsafe)** → **Allow**.
   (Ini skrip milik Anda sendiri, jadi aman.)
8. Di **Execution log** bawah harus muncul email Drive Anda dan
   `Password : sudah diatur ✔`.

### C. Terbitkan

9. Klik **Deploy** (kanan atas) → **New deployment** → klik ikon roda gigi di
   samping "Select type" → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   → **Deploy**.
10. Salin **Web app URL** (`https://script.google.com/macros/s/……/exec`)
    dan kirim ke Claude, atau isi sendiri di `config.js`:
    ```js
    SERVER_URL: "https://script.google.com/macros/s/……/exec",
    ```
11. Unggah isi folder `private-main` ke GitHub (akun admin.vena).

---

## Sehari-hari

- **Masuk:** buka vena.web.id → ketik password → Masuk.
- **Ingat saya** (dicentang): tetap masuk 30 hari di perangkat itu.
  Di komputer umum: hapus centangnya, lalu klik **Keluar** setelah selesai
  (tanpa centang, sesi hilang saat browser ditutup).
- **Salah password 5x:** login dikunci 15 menit (melindungi dari tebak-tebakan).
- **Ganti password:** script.google.com → project Vena → Project Settings →
  Script Properties → ubah `APP_PASSWORD`. Semua perangkat yang sedang masuk
  otomatis keluar.
- **HP/laptop hilang:** ganti password seperti di atas.

## Catatan

- Kalau `Code.gs` diubah nanti: Deploy → Manage deployments → ✏️ →
  Version: **New version** → Deploy (alamatnya tetap sama).
- Folder "Vena Drive" lama yang kosong (dari uji coba login Google) boleh
  dihapus di drive.google.com; Vena akan membuat folder barunya sendiri.
- Aplikasi kalkulator lama (Firebase) tidak dipakai lagi. Kunci Firestore:
  Firebase Console → Firestore Database → Rules →
  `allow read, write: if false;` → Publish.
