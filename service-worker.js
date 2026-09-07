// Service Worker MINIMAL - tujuan SATU-SATUNYA cuma supaya aplikasi ini
// memenuhi syarat teknis "installable" (bisa di-Add to Home Screen / muncul
// tombol Install), TIDAK melakukan apa pun terhadap request jaringan.
//
// Versi sebelumnya sempat mencoba fallback offline dengan meng-intercept
// event 'fetch' untuk navigasi - ini ternyata JUSTRU menyebabkan PWA gagal
// terbuka di Android (loading sebentar lalu "mental" keluar tanpa masuk ke
// halaman). Karena aplikasi ini SELALU butuh koneksi internet (data live
// dari Firebase/Firestore), fitur offline tidak krusial - jadi bagian
// paling rawan itu sengaja DIHAPUS TOTAL di sini demi stabilitas.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// SENGAJA TIDAK ADA event listener 'fetch' sama sekali - biarkan semua
// request jaringan berjalan normal apa adanya, tanpa campur tangan.
