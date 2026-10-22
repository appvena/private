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
const VERSION = 'vena-3.1.2';
const SHARE_DB = 'vena-share-target';

function openShareDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(SHARE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function saveShareRequest(request) {
  const form = await request.formData();
  const files = form.getAll('files').filter(v => v && typeof v.arrayBuffer === 'function');
  if (!files.length) return;
  const db = await openShareDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('inbox', 'readwrite');
    tx.objectStore('inbox').add({ created: Date.now(), title: String(form.get('title') || ''), text: String(form.get('text') || ''), files });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}

self.addEventListener('install', () => {});
self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OFFLINE_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vena — tidak ada koneksi</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#F2F4F1;color:#1B2420;text-align:center;padding:24px}
@media(prefers-color-scheme:dark){body{background:#121816;color:#E4EBE7}}
b{display:block;font-size:22px;margin-bottom:8px}button{margin-top:18px;padding:11px 22px;border:0;border-radius:999px;background:#0E6B63;color:#fff;font-weight:700;font-size:15px}</style></head>
<body><div><b>Tidak ada koneksi internet</b>Vena membutuhkan internet untuk membuka file Anda.<br>Periksa Wi-Fi atau data seluler, lalu coba lagi.<br><button onclick="location.reload()">Coba lagi</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST' && new URL(req.url).pathname === new URL('./share-target', self.registration.scope).pathname) {
    event.respondWith((async () => {
      try { await saveShareRequest(req); } catch (e) { /* aplikasi tetap dibuka agar bisa memberi pesan */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (req.mode !== 'navigate' || req.method !== 'GET') return;   // selain halaman: biarkan
  event.respondWith(
    fetch(req).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  );
});
