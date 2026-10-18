// =====================================================================
//  Service worker Vena — © 2026 SRISP
//
//  Tujuan: memenuhi syarat "bisa dipasang" (Instal aplikasi) di semua
//  Chrome, termasuk versi lama di Windows 7 yang mensyaratkan adanya
//  penanganan 'fetch'.
//
//  Dibuat seaman mungkin:
//  - HANYA menangani pembukaan halaman (navigasi). File lain (gambar,
//    skrip, Google Drive) sama sekali tidak disentuh.
//  - Permintaan diteruskan apa adanya ke jaringan (redirect ikut diteruskan
//    oleh browser, tidak pernah memakai salinan lama yang bisa membuat
//    aplikasi "mental" keluar di Android).
//  - Hanya kalau benar-benar tidak ada internet, tampilkan halaman kecil
//    "Tidak ada koneksi" yang dibuat langsung di sini (bukan dari cache).
// =====================================================================
const VERSION = 'vena-3.0.0';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OFFLINE_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vena — tidak ada koneksi</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#F2F4F1;color:#1B2420;text-align:center;padding:24px}
@media(prefers-color-scheme:dark){body{background:#121816;color:#E4EBE7}}
b{display:block;font-size:22px;margin-bottom:8px}button{margin-top:18px;padding:11px 22px;border:0;border-radius:999px;background:#0E6B63;color:#fff;font-weight:700;font-size:15px}</style></head>
<body><div><b>Tidak ada koneksi internet</b>Vena membutuhkan internet untuk membuka file Anda.<br>Periksa Wi-Fi atau data seluler, lalu coba lagi.<br><button onclick="location.reload()">Coba lagi</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;   // selain halaman: biarkan
  event.respondWith(
    fetch(req).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  );
});
