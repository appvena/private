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

  // Alamat server login (Web app Google Apps Script). Kalau diisi, masuk ke
  // Vena cukup dengan password — tanpa akun Google, tanpa HP.
  // Bentuknya: https://script.google.com/macros/s/XXXXXXXX/exec
  // Kalau dikosongkan, masuk memakai akun Google seperti biasa.
  SERVER_URL: "https://script.google.com/macros/s/AKfycbykiE_pKpOe0ZSOD9LQ6xsQ67x0ZyztbmPSfpWv4Q9hoZdKo5fhhiM0g7XqB8UaqQaB/exec",

  // Nama folder utama yang dibuat otomatis di Google Drive.
  // Semua file yang diunggah lewat aplikasi ini disimpan di dalamnya.
  ROOT_FOLDER_NAME: "Vena Drive",

  // Nama aplikasi yang tampil di layar.
  APP_NAME: "Vena"
};
