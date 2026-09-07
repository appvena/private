// Service Worker minimal - tujuan utamanya cuma supaya aplikasi ini
// memenuhi syarat "installable" (bisa di-Add to Home Screen).
// TIDAK melakukan caching agresif - aplikasi ini butuh data selalu
// terbaru dari Firebase/Firestore, jadi kita SENGAJA tidak menyimpan
// cache offline untuk data (supaya tidak pernah menampilkan data basi).

const CACHE_NAME = 'kalkulator-outlet-shell-v1';
const SHELL_FILES = [
  './index.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Strategi: network-first untuk index.html (selalu coba ambil versi terbaru
// dari server dulu), baru jatuh ke cache kalau benar-benar offline.
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('./index.html'))
    );
  }
});
