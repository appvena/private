// =====================================================================
//  KONFIGURASI VENA DRIVE
//  Ini satu-satunya file yang perlu Anda ubah. Lihat PANDUAN-SETUP.md.
// =====================================================================
window.VENA_CONFIG = {
  // OAuth Client ID dari Google Cloud Console (jenis: Web application).
  // Contoh: "1234567890-abcdefg.apps.googleusercontent.com"
  // Kalau dibiarkan kosong, aplikasi akan menampilkan layar setup
  // tempat Anda bisa menempelkan Client ID langsung dari browser.
  CLIENT_ID: "905796727642-ij44t38alm6gqfavee9rgtapdkt4bn71.apps.googleusercontent.com",

  // Satu-satunya akun yang boleh masuk. File tersimpan di Google Drive akun ini.
  ALLOWED_EMAIL: "saidrezairfansyahputra@gmail.com",
  STORAGE_EMAIL: "saidrezairfansyahputra@gmail.com",

  // Biarkan kosong. (Hanya diisi kalau nanti ingin login memakai akun lain
  // dari akun penyimpanan; perlu skrip penjaga di Google Apps Script.)
  BROKER_URL: "",

  // Nama folder utama yang dibuat otomatis di Google Drive.
  // Semua file yang diunggah lewat aplikasi ini disimpan di dalamnya.
  ROOT_FOLDER_NAME: "Vena Drive",

  // Nama aplikasi yang tampil di layar.
  APP_NAME: "Vena"
};
