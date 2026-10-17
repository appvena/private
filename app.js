/* =====================================================================
   VENA — aplikasi penyimpanan pribadi di atas Google Drive
   Tanpa server: browser langsung bicara ke Google Drive API memakai
   token OAuth dari Google Identity Services.
   ===================================================================== */
(() => {
'use strict';

/* ---------------------------------------------------------------- konfigurasi */
const CFG = Object.assign({
  CLIENT_ID: '', ALLOWED_EMAIL: '', BROKER_URL: '', STORAGE_EMAIL: '', ROOT_FOLDER_NAME: 'Vena Drive', APP_NAME: 'Vena'
}, window.VENA_CONFIG || {});
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const clientId = () => (CFG.CLIENT_ID || LS.get('vena.clientId') || '').trim();
// Akun yang boleh login. Tanpa penjaga (BROKER_URL kosong), akun login = akun penyimpanan.
const allowedEmail = () => ((CFG.BROKER_URL || '').trim()
  ? (CFG.ALLOWED_EMAIL || '')
  : (CFG.STORAGE_EMAIL || CFG.ALLOWED_EMAIL || LS.get('vena.allowedEmail') || '')).trim().toLowerCase();

// Izin "drive.file": aplikasi HANYA bisa melihat & mengubah file yang dibuat
// lewat aplikasi ini sendiri. File lain di Google Drive tidak terjangkau sama sekali.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink,starred,webViewLink,parents,shared,trashed,explicitlyTrashed,fileExtension';

/* ---------------------------------------------------------------- state */
const S = {
  token: null, exp: 0, bsession: null, admin: null, user: null, quota: null, rootId: null,
  route: { type: 'folder', id: null, q: '' },
  items: [], selected: new Set(),
  view: LS.get('vena.view') || 'grid',
  sort: LS.get('vena.sort') || 'name',
  meta: new Map(),         // id -> {name, parents}  untuk breadcrumb
  loadSeq: 0,
};
let tokenClient = null;

/* ---------------------------------------------------------------- util */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qstr = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const icon = (id, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const isFolder = (f) => f.mimeType === FOLDER;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fmtSize(n) {
  n = Number(n);
  if (!isFinite(n) || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toLocaleString('id-ID', { maximumFractionDigits: n < 10 ? 1 : 0 })) + ' ' + u[i];
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const opt = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opt.year = 'numeric';
  return d.toLocaleDateString('id-ID', opt);
}
function extOf(f) { return (f.fileExtension || (f.name.includes('.') ? f.name.split('.').pop() : '') || '').toLowerCase(); }
const TEXT_EXT = ['txt','md','csv','json','js','ts','jsx','tsx','html','htm','css','xml','yml','yaml','py','php','java','c','h','cpp','go','rs','sh','sql','log','ini','env','kt','swift','rb','vue','svelte'];
function kindOf(f) {
  const m = f.mimeType || '', e = extOf(f);
  if (m === FOLDER) return 'folder';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  if (m.includes('spreadsheet') || m.includes('excel') || ['xls','xlsx','csv','ods'].includes(e)) return 'sheet';
  if (m.includes('presentation') || m.includes('powerpoint') || ['ppt','pptx','key','odp'].includes(e)) return 'slides';
  if (m.includes('document') || m.includes('msword') || ['doc','docx','odt','rtf','txt','md','pages'].includes(e)) return 'doc';
  if (m.includes('zip') || m.includes('compressed') || ['zip','rar','7z','tar','gz','tgz','bz2','xz'].includes(e)) return 'archive';
  if (TEXT_EXT.includes(e) || m.startsWith('text/')) return 'code';
  return 'file';
}
const KIND_ICON = { image: 'f-image', video: 'f-video', audio: 'f-audio', pdf: 'f-pdf', sheet: 'f-sheet', slides: 'f-slides', doc: 'f-pdf', archive: 'f-archive', code: 'f-code', file: 'f-file', folder: 'i-folder' };

/* ---------------------------------------------------------------- toast */
function toast(msg, { error = false, action, onAction, ms = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { el.remove(); onAction && onAction(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), ms);
}
function fail(e, prefix) {
  if (e && e.auth) return;            // sudah ditangani oleh banner sesi
  console.error(e);
  toast((prefix ? prefix + ': ' : '') + (e && e.message ? e.message : 'Terjadi kesalahan'), { error: true, ms: 7000 });
}

/* ---------------------------------------------------------------- tema */
function applyTheme() {
  const t = LS.get('vena.theme');
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('#btnTheme use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('#btnTheme').setAttribute('aria-label', dark ? 'Pakai tema terang' : 'Pakai tema gelap');
  $('#menuTheme use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('#menuThemeText').textContent = dark ? 'Tema terang' : 'Tema gelap';
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  LS.set('vena.theme', dark ? 'light' : 'dark');
  applyTheme();
}

/* ---------------------------------------------------------------- layar */
function show(id) {
  for (const s of ['screenLoading', 'screenSetup', 'screenLogin', 'screenLink', 'screenApp']) $('#' + s).hidden = s !== id;
}

/* ================================================================ AUTENTIKASI
   Dua mode:
   - Mode PENJAGA (BROKER_URL diisi): orang login dengan akun admin, lalu server
     kecil (Google Apps Script) memeriksa akun itu dan memberi akses sementara ke
     Drive akun penyimpanan. Akses itu juga hanya "drive.file".
   - Mode LANGSUNG (BROKER_URL kosong): akun yang login = akun penyimpanan.
   ================================================================ */
class AuthError extends Error { constructor() { super('Sesi Google habis'); this.auth = true; } }
const brokerUrl = () => (CFG.BROKER_URL || '').trim();
const brokerMode = () => !!brokerUrl();
const storageEmail = () => (CFG.STORAGE_EMAIL || '').trim().toLowerCase();

function waitForGis() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      if (Date.now() - t0 > 15000) return reject(new Error('Layanan login Google tidak bisa dimuat. Periksa koneksi internet lalu muat ulang halaman.'));
      setTimeout(poll, 100);
    })();
  });
}

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId(),
    scope: brokerMode() ? 'openid email profile' : DRIVE_SCOPE,
    callback: () => {},
  });
}

function gisError(e) {
  const map = {
    popup_closed: 'Jendela login ditutup sebelum selesai.',
    popup_failed_to_open: 'Jendela login diblokir browser. Izinkan pop-up untuk situs ini, lalu coba lagi.',
  };
  return new Error(map[e.type] || e.message || e.type);
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error_description || r.error));
      if (!brokerMode() && !google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE))
        return reject(new Error('Akses ke Google Drive belum diizinkan. Masuk lagi dan centang izin Google Drive.'));
      resolve(r);
    };
    tokenClient.error_callback = (e) => reject(gisError(e));
    const hint = allowedEmail() || LS.get('vena.lastEmail') || '';
    const opts = { prompt };
    if (hint) opts.login_hint = hint;
    tokenClient.requestAccessToken(opts);
  });
}

/* ---- panggil penjaga (Apps Script) ---- */
async function broker(action, data = {}) {
  let res;
  try {
    res = await fetch(brokerUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // tanpa preflight CORS
      body: JSON.stringify(Object.assign({ action }, data)),
    });
  } catch {
    throw new Error('Server Vena (Apps Script) tidak bisa dihubungi. Periksa koneksi internet dan BROKER_URL di config.js.');
  }
  let j;
  try { j = await res.json(); }
  catch { throw new Error('Balasan server Vena tidak valid. Pastikan Apps Script di-deploy sebagai Web app dengan akses "Anyone".'); }
  if (j.error) { const e = new Error(j.message || j.error); e.code = j.error; throw e; }
  return j;
}

/* ---- penyimpanan sesi lokal ---- */
function saveSession() {
  LS.set('vena.session', JSON.stringify({ token: S.token, exp: S.exp, bs: S.bsession, admin: S.admin }));
}
function loadSession() {
  try {
    const s = JSON.parse(LS.get('vena.session') || 'null');
    if (!s) return;
    if (s.token && s.exp > Date.now() + 30000) { S.token = s.token; S.exp = s.exp; }
    if (s.bs && s.bs.exp > Date.now()) S.bsession = s.bs;
    if (s.admin) S.admin = s.admin;
  } catch {}
}
function setToken(r) {
  S.token = r.access_token;
  S.exp = Date.now() + (Number(r.expires_in || 3599) - 60) * 1000;
  saveSession();
}
function clearSession() {
  S.token = null; S.exp = 0; S.bsession = null; S.admin = null;
  LS.del('vena.session');
}
function expireSession() {
  clearSession();
  if (!$('#screenApp').hidden) $('#sessionBanner').hidden = false;
}

/* ---- token Drive yang selalu segar ---- */
let tokenPromise = null;
async function getToken(force = false) {
  if (!force && S.token && Date.now() < S.exp) return S.token;
  if (!brokerMode() || !S.bsession || Date.now() > S.bsession.exp) { expireSession(); throw new AuthError(); }
  if (!tokenPromise) {
    tokenPromise = (async () => {
      try {
        setToken(await broker('token', { session: S.bsession.id }));
        return S.token;
      } catch (e) {
        if (e.code === 'AUTH' || e.code === 'FORBIDDEN') { expireSession(); throw new AuthError(); }
        if (e.code === 'NOT_LINKED') { S.token = null; showLink(); throw new AuthError(); }
        throw e;
      }
    })().finally(() => { tokenPromise = null; });
  }
  return tokenPromise;
}

/* ---- login ---- */
async function loginWith(r) {
  // mode langsung: token login = token Drive
  if (!brokerMode()) { setToken(r); return true; }
  // mode penjaga: kenali akun admin, lalu minta akses Drive ke penjaga
  let info = {};
  try {
    const u = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + r.access_token } });
    info = await u.json();
  } catch {}
  const email = String(info.email || '').toLowerCase();
  const allow = allowedEmail();
  if (allow && email && email !== allow) throw new Error(`Akun ${email} tidak diizinkan. Masuk dengan ${allow}.`);
  const res = await broker('login', { access_token: r.access_token });
  S.bsession = { id: res.session, exp: Date.now() + (Number(res.session_ttl) - 120) * 1000 };
  S.admin = { email, name: info.name || email, picture: info.picture || '' };
  LS.set('vena.lastEmail', email);
  LS.set('vena.lastName', S.admin.name);
  saveSession();
  if (!res.linked || !res.drive) { showLink(); return false; }
  setToken(res.drive);
  return true;
}

async function signIn(prompt) {
  $('#loginError').textContent = '';
  $('#btnLogin').disabled = true;
  try {
    const r = await requestToken(prompt);
    if (await loginWith(r)) await afterLogin();
  } catch (e) {
    if (!$('#screenApp').hidden) fail(e); else $('#loginError').textContent = e.message;
  } finally {
    $('#btnLogin').disabled = false;
  }
}

async function afterLogin() {
  const about = await api('/about', { query: { fields: 'user(displayName,emailAddress,photoLink),storageQuota' } });
  const email = (about.user.emailAddress || '').toLowerCase();
  if (!brokerMode()) {
    const allow = allowedEmail();
    if (allow && email !== allow) {
      try { google.accounts.oauth2.revoke(S.token, () => {}); } catch {}
      clearSession();
      show('screenLogin');
      $('#loginError').textContent = `Akun ${email} tidak diizinkan. Masuk dengan ${allow}.`;
      return;
    }
    LS.set('vena.lastEmail', email);
    LS.set('vena.lastName', about.user.displayName || '');
  }
  S.user = about.user;          // pemilik Drive penyimpanan
  S.quota = about.storageQuota;
  $('#sessionBanner').hidden = true;
  renderAccount();
  renderQuota();
  show('screenApp');
  await ensureRoot();
  refreshAppUsage();
  onRoute();
}

async function reconnect() {
  try {
    const r = await requestToken('');
    if (!(await loginWith(r))) return;
    $('#sessionBanner').hidden = true;
    toast('Tersambung lagi.');
    refreshQuota();
    onRoute(true);
  } catch (e) { toast(e.message, { error: true }); }
}

function logout() {
  clearSession();
  S.user = null; S.rootId = null;
  location.hash = '';
  setupLoginScreen();
  show('screenLogin');
}

/* ---- hubungkan Drive penyimpanan (sekali saja, mode penjaga) ---- */
function showLink() {
  const se = storageEmail();
  $('#linkEmail').textContent = se || 'akun Google penyimpanan';
  $('#linkAdmin').textContent = S.admin ? S.admin.email : '';
  $('#linkError').textContent = '';
  show('screenLink');
}
function linkStorage() {
  $('#linkError').textContent = '';
  const btn = $('#btnLink');
  btn.disabled = true;
  const cc = google.accounts.oauth2.initCodeClient({
    client_id: clientId(),
    scope: 'openid email ' + DRIVE_SCOPE,
    ux_mode: 'popup',
    select_account: true,
    login_hint: storageEmail() || undefined,
    callback: async (r) => {
      try {
        if (r.error) throw new Error(r.error_description || r.error);
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE))
          throw new Error('Izin Google Drive belum dicentang. Klik lagi dan centang izinnya.');
        if (!S.bsession) throw new Error('Sesi admin habis. Keluar lalu masuk lagi.');
        const res = await broker('link', { session: S.bsession.id, code: r.code });
        setToken(res);
        toast('Drive penyimpanan terhubung.');
        await afterLogin();
      } catch (e) {
        $('#linkError').textContent = e.message;
      } finally { btn.disabled = false; }
    },
    error_callback: (e) => { $('#linkError').textContent = gisError(e).message; btn.disabled = false; },
  });
  cc.requestCode();
}

/* ================================================================ DRIVE API */
async function api(path, { method = 'GET', query, body, raw = false, signal, _retry = false } = {}) {
  const token = await getToken();
  const url = new URL(path.startsWith('http') ? path : API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const headers = { Authorization: 'Bearer ' + token };
  if (body) headers['Content-Type'] = 'application/json; charset=UTF-8';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Tidak bisa terhubung ke Google Drive. Periksa koneksi internet.');
  }
  if (res.status === 401) {
    S.token = null;
    if (brokerMode() && !_retry) return api(path, { method, query, body, raw, signal, _retry: true });
    expireSession(); throw new AuthError();
  }
  if (!res.ok) {
    let msg = 'Google Drive menolak permintaan (' + res.status + ')';
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch {}
    if (res.status === 403 && /storage quota/i.test(msg)) msg = 'Ruang Google Drive sudah penuh.';
    const err = new Error(msg); err.status = res.status; throw err;
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function listAll(q, { orderBy, max = 2000 } = {}) {
  const out = [];
  let pageToken;
  do {
    const r = await api('/files', { query: { q, orderBy, pageSize: 1000, pageToken, fields: `nextPageToken,files(${FIELDS})`, spaces: 'drive' } });
    out.push(...(r.files || []));
    pageToken = r.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

async function ensureRoot() {
  const key = 'vena.root.' + S.user.emailAddress;
  const cached = LS.get(key);
  if (cached) {
    try {
      const f = await api('/files/' + cached, { query: { fields: 'id,trashed' } });
      if (f && !f.trashed) { S.rootId = f.id; return; }
    } catch (e) { if (e.auth) throw e; }
  }
  const r = await api('/files', { query: {
    q: `appProperties has { key='venaRoot' and value='1' } and mimeType='${FOLDER}' and trashed=false`,
    fields: 'files(id,name)', pageSize: 10, spaces: 'drive' } });
  let id = r.files && r.files[0] && r.files[0].id;
  if (!id) {
    const f = await api('/files', { method: 'POST', query: { fields: 'id' }, body: {
      name: CFG.ROOT_FOLDER_NAME, mimeType: FOLDER, appProperties: { venaRoot: '1' },
      description: 'Folder penyimpanan aplikasi ' + CFG.APP_NAME + ' (' + location.host + ')' } });
    id = f.id;
  }
  S.rootId = id;
  LS.set(key, id);
}

async function refreshQuota() {
  try {
    const a = await api('/about', { query: { fields: 'storageQuota' } });
    S.quota = a.storageQuota; renderQuota();
  } catch {}
  refreshAppUsage();
}
// total ukuran file yang disimpan lewat aplikasi ini (termasuk yang di Sampah)
async function refreshAppUsage() {
  try {
    let total = 0, count = 0, pageToken;
    do {
      const r = await api('/files', { query: { q: `mimeType!='${FOLDER}'`, pageSize: 1000, pageToken, fields: 'nextPageToken,files(size)', spaces: 'drive' } });
      for (const f of r.files || []) { total += Number(f.size) || 0; count++; }
      pageToken = r.nextPageToken;
    } while (pageToken);
    S.appUsage = { total, count };
    renderQuota();
  } catch {}
}
let quotaTimer;
const refreshQuotaSoon = () => { clearTimeout(quotaTimer); quotaTimer = setTimeout(refreshQuota, 1500); };

/* ================================================================ RUTE */
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!h) return { type: 'folder', id: S.rootId };
  if (h.startsWith('f/')) return { type: 'folder', id: h.slice(2) || S.rootId };
  if (h.startsWith('search/')) return { type: 'search', q: h.slice(7) };
  if (['recent', 'starred', 'shared', 'trash'].includes(h)) return { type: h };
  return { type: 'folder', id: S.rootId };
}
const folderHash = (id) => id === S.rootId ? '#/' : '#/f/' + id;
const curFolderId = () => S.route.type === 'folder' ? S.route.id : S.rootId;

function onRoute(silent = false) {
  if (!S.rootId) return;
  S.route = parseHash();
  S.selected.clear();
  closeMenus();
  const navKey = S.route.type === 'folder' ? (S.route.id === S.rootId ? 'home' : '') : S.route.type;
  for (const a of $$('.nav a')) a.classList.toggle('active', a.dataset.nav === navKey || (navKey === '' && a.dataset.nav === 'home'));
  if (S.route.type !== 'search') $('#searchInput').value = '';
  else $('#searchInput').value = S.route.q;
  $('#screenApp').classList.remove('nav-open');
  $('#trashNote').hidden = S.route.type !== 'trash';
  $('#sortSelect').hidden = S.route.type === 'recent';
  loadView(silent);
}

async function loadView(silent = false) {
  const seq = ++S.loadSeq;
  const r = S.route;
  renderCrumbs();
  if (!silent) {
    $('#foldersSection').hidden = $('#filesSection').hidden = $('#emptyState').hidden = true;
    $('#listLoading').hidden = false;
  }
  try {
    let items;
    if (r.type === 'folder') {
      items = await listAll(`'${qstr(r.id)}' in parents and trashed=false`, { orderBy: 'folder,name' });
    } else if (r.type === 'recent') {
      const res = await api('/files', { query: { q: `trashed=false and mimeType!='${FOLDER}'`, orderBy: 'modifiedTime desc', pageSize: 60, fields: `files(${FIELDS})`, spaces: 'drive' } });
      items = res.files || [];
    } else if (r.type === 'starred') {
      items = await listAll('starred=true and trashed=false');
    } else if (r.type === 'shared') {
      items = await listAll("visibility='anyoneWithLink' and trashed=false");
    } else if (r.type === 'trash') {
      items = (await listAll('trashed=true')).filter(f => f.explicitlyTrashed !== false);
    } else if (r.type === 'search') {
      items = r.q ? await listAll(`name contains '${qstr(r.q)}' and trashed=false`, { max: 500 }) : [];
    }
    if (seq !== S.loadSeq) return;
    items = items.filter(f => f.id !== S.rootId);
    S.items = items;
    for (const f of items) if (isFolder(f)) S.meta.set(f.id, { name: f.name, parents: f.parents });
    render();
  } catch (e) {
    if (seq !== S.loadSeq) return;
    $('#listLoading').hidden = true;
    if (e.auth) { S.items = []; showEmpty('session'); return; }
    if (e.status === 404) { showEmpty('missing'); return; }
    fail(e, 'Gagal memuat');
    showEmpty('error');
  } finally {
    if (seq === S.loadSeq) $('#listLoading').hidden = true;
  }
}

/* ---------------------------------------------------------------- breadcrumb */
async function folderChain(id) {
  const chain = [];
  let cur = id, guard = 0;
  while (cur && cur !== S.rootId && guard++ < 25) {
    let m = S.meta.get(cur);
    if (!m) {
      try {
        const f = await api('/files/' + cur, { query: { fields: 'id,name,parents' } });
        m = { name: f.name, parents: f.parents }; S.meta.set(cur, m);
      } catch { break; }
    }
    chain.unshift({ id: cur, name: m.name });
    cur = m.parents && m.parents[0];
    if (!cur) break;
  }
  return chain;
}

async function renderCrumbs() {
  const el = $('#crumbs');
  const r = S.route;
  const titles = { recent: 'Terbaru', starred: 'Berbintang', shared: 'Dibagikan dengan link', trash: 'Sampah' };
  if (r.type === 'search') { el.innerHTML = `<span class="current">Hasil untuk “${esc(r.q)}”</span>`; return; }
  if (r.type !== 'folder') { el.innerHTML = `<span class="current">${titles[r.type]}</span>`; return; }
  if (r.id === S.rootId) { el.innerHTML = `<span class="current">File saya</span>`; return; }
  const seq = S.loadSeq;
  el.innerHTML = `<button data-go="${S.rootId}">File saya</button><span class="sep">${icon('i-chevron-right')}</span><span class="current">…</span>`;
  const chain = await folderChain(r.id);
  if (seq !== S.loadSeq) return;
  let html = `<button data-go="${S.rootId}">File saya</button>`;
  chain.forEach((c, i) => {
    html += `<span class="sep">${icon('i-chevron-right')}</span>`;
    html += i === chain.length - 1 ? `<span class="current" title="${esc(c.name)}">${esc(c.name)}</span>` : `<button data-go="${c.id}" title="${esc(c.name)}">${esc(c.name)}</button>`;
  });
  el.innerHTML = html;
  document.title = (chain.length ? chain[chain.length - 1].name + ' — ' : '') + CFG.APP_NAME;
}

/* ================================================================ RENDER */
function sorted(list) {
  const a = [...list];
  if (S.route.type === 'recent') return a;
  const byName = (x, y) => x.name.localeCompare(y.name, 'id', { numeric: true, sensitivity: 'base' });
  if (S.sort === 'modified') a.sort((x, y) => (y.modifiedTime || '').localeCompare(x.modifiedTime || '') || byName(x, y));
  else if (S.sort === 'size') a.sort((x, y) => (Number(y.size) || 0) - (Number(x.size) || 0) || byName(x, y));
  else a.sort(byName);
  return a;
}
const visibleFolders = () => sorted(S.items.filter(isFolder));
const visibleFiles = () => sorted(S.items.filter(f => !isFolder(f)));

function render() {
  const folders = visibleFolders(), files = visibleFiles();
  const trash = S.route.type === 'trash';
  $('#foldersSection').hidden = !folders.length;
  $('#filesSection').hidden = !files.length;
  $('#folders').innerHTML = folders.map(f => folderHTML(f)).join('');
  const filesEl = $('#files');
  filesEl.className = 'files ' + S.view;
  filesEl.innerHTML = files.map(f => fileHTML(f, trash)).join('');
  if (!folders.length && !files.length) showEmpty(S.route.type); else $('#emptyState').hidden = true;
  hookThumbs();
  renderSelection();
  for (const b of $$('.seg button')) b.classList.toggle('on', b.dataset.view === S.view);
  $('#sortSelect').value = S.sort;
  if (S.route.type !== 'folder' || S.route.id === S.rootId) document.title = CFG.APP_NAME + ' — Penyimpanan';
}

function folderHTML(f) {
  const sel = S.selected.has(f.id);
  return `<div class="folder item${sel ? ' selected' : ''}" data-id="${f.id}" tabindex="0" role="button" aria-label="Folder ${esc(f.name)}">
    <span class="fico">${icon('i-folder')}</span>
    <button class="check" data-check aria-label="Pilih ${esc(f.name)}" aria-pressed="${sel}">${icon('i-check')}</button>
    <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
    ${f.starred ? `<span class="star-flag" title="Berbintang">${icon('i-star')}</span>` : ''}
    <button class="icon-btn" data-more aria-label="Pilihan untuk ${esc(f.name)}">${icon('i-more')}</button>
  </div>`;
}

function fileHTML(f, trash) {
  const k = kindOf(f), sel = S.selected.has(f.id);
  const thumb = f.thumbnailLink ? `<img data-thumb loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(f.thumbnailLink.replace(/=s\d+$/, '=s400'))}">` : '';
  const when = trash ? 'Dihapus' : fmtDate(f.modifiedTime);
  return `<div class="file item${sel ? ' selected' : ''}" data-id="${f.id}" tabindex="0" role="button" style="--kind: var(--k-${k === 'folder' ? 'file' : k})" aria-label="${esc(f.name)}">
    <div class="thumb" data-kind="${k}">${thumb || icon(KIND_ICON[k])}</div>
    <button class="check" data-check aria-label="Pilih ${esc(f.name)}" aria-pressed="${sel}">${icon('i-check')}</button>
    ${f.starred ? `<span class="star-flag" title="Berbintang">${icon('i-star')}</span>` : ''}
    <div class="meta">
      <span class="kind-ico">${icon(KIND_ICON[k])}</span>
      <div class="text">
        <div class="name" title="${esc(f.name)}">${esc(f.name)}${f.starred ? `<span class="name-star" title="Berbintang">${icon('i-star')}</span>` : ''}</div>
        <div class="sub"><span>${trash ? '' : esc(fmtDate(f.modifiedTime))}</span><span>${esc(fmtSize(f.size))}</span></div>
      </div>
      <button class="icon-btn" data-more aria-label="Pilihan untuk ${esc(f.name)}">${icon('i-more')}</button>
    </div>
  </div>`;
}

/* thumbnail: pakai thumbnailLink dari Drive; kalau gagal dan file-nya gambar kecil,
   ambil isi file langsung (lazy, saat terlihat di layar). */
const blobThumbs = new Map();
let thumbObserver;
function hookThumbs() {
  if (!thumbObserver && 'IntersectionObserver' in window) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { thumbObserver.unobserve(en.target); loadBlobThumb(en.target); }
    }, { rootMargin: '200px' });
  }
  for (const img of $$('#files img[data-thumb]')) {
    img.onerror = () => {
      const box = img.parentElement;
      const card = box.closest('.file');
      const f = S.items.find(x => x.id === card.dataset.id);
      box.innerHTML = icon(KIND_ICON[box.dataset.kind]);
      if (f && box.dataset.kind === 'image' && Number(f.size) < 6e6) {
        if (thumbObserver) thumbObserver.observe(box); else loadBlobThumb(box);
      }
    };
  }
  for (const box of $$('#files .thumb[data-kind="image"]')) {
    if (box.querySelector('img')) continue;
    const id = box.closest('.file').dataset.id;
    const f = S.items.find(x => x.id === id);
    if (blobThumbs.has(id)) { box.innerHTML = `<img alt="" src="${blobThumbs.get(id)}">`; continue; }
    if (f && Number(f.size) < 6e6 && thumbObserver) thumbObserver.observe(box);
  }
}
async function loadBlobThumb(box) {
  const card = box.closest('.file'); if (!card) return;
  const id = card.dataset.id;
  try {
    let url = blobThumbs.get(id);
    if (!url) {
      const res = await api('/files/' + id, { query: { alt: 'media' }, raw: true });
      url = URL.createObjectURL(await res.blob());
      blobThumbs.set(id, url);
    }
    if (box.isConnected) {
      box.innerHTML = `<img alt="" src="${url}">`;
      box.firstChild.onerror = () => { box.innerHTML = icon('f-image'); };
    }
  } catch {}
}

function showEmpty(kind) {
  $('#foldersSection').hidden = $('#filesSection').hidden = true;
  const el = $('#emptyState');
  const states = {
    folder: S.route.id === S.rootId
      ? ['Laci Anda masih kosong', 'Seret file ke sini atau mulai dengan mengunggah. Semua file tersimpan di folder “' + CFG.ROOT_FOLDER_NAME + '” di Google Drive.', 'Unggah file']
      : ['Folder ini kosong', 'Seret file ke sini, atau unggah dari perangkat Anda.', 'Unggah file'],
    recent: ['Belum ada file', 'File yang baru diunggah atau diubah akan muncul di sini.', 'Unggah file'],
    starred: ['Belum ada yang berbintang', 'Beri bintang pada file atau folder penting lewat menu ⋮ supaya mudah ditemukan.'],
    shared: ['Belum ada yang dibagikan', 'File dan folder yang Anda bagikan lewat link akan terkumpul di sini.'],
    trash: ['Sampah kosong', 'File yang Anda hapus bisa dipulihkan dari sini selama 30 hari.'],
    search: ['Tidak ada yang cocok', 'Coba kata lain, atau periksa ejaan nama file.'],
    session: ['Sesi Google habis', 'Sambungkan lagi untuk melihat file Anda.', 'Sambungkan lagi', 'reconnect'],
    missing: ['Folder tidak ditemukan', 'Folder ini mungkin sudah dihapus atau dipindahkan.', 'Kembali ke File saya', 'home'],
    error: ['File tidak bisa dimuat', 'Periksa koneksi internet, lalu coba lagi.', 'Coba lagi', 'retry'],
  };
  const [t, d, cta, act = 'upload-files'] = states[kind] || states.folder;
  el.innerHTML = `<div class="empty-art" aria-hidden="true"></div><h3>${esc(t)}</h3><p>${esc(d)}</p>${cta ? `<button class="btn btn-primary" data-action="${act}">${esc(cta)}</button>` : ''}`;
  el.hidden = false;
}

function renderAccount() {
  const st = S.user;
  const a = brokerMode() && S.admin ? S.admin : { name: st.displayName, email: st.emailAddress, picture: st.photoLink };
  const u = { displayName: a.name, emailAddress: a.email, photoLink: a.picture };
  $('#accName').textContent = u.displayName || 'Akun Google';
  $('#accEmail').textContent = u.emailAddress;
  $('#accStorage').hidden = !brokerMode();
  $('#accStorage').textContent = 'File tersimpan di Drive ' + st.emailAddress;
  $('#avatarInitial').textContent = (u.displayName || u.emailAddress || '?').trim()[0].toUpperCase();
  const img = $('#avatarImg');
  if (u.photoLink) {
    img.onload = () => { img.hidden = false; $('#avatarInitial').hidden = true; };
    img.onerror = () => { img.hidden = true; $('#avatarInitial').hidden = false; };
    img.src = u.photoLink;
  }
  $('#quotaDrive').href = 'https://drive.google.com/drive/folders/' + (S.rootId || '') + '?authuser=' + encodeURIComponent(st.emailAddress);
}
function renderQuota() {
  const q = S.quota || {};
  const used = Number(q.usage) || 0, lim = Number(q.limit) || 0;
  const pct = lim ? Math.min(100, used / lim * 100) : 0;
  $('#quotaFill').style.width = pct + '%';
  $('.quota-bar').classList.toggle('warn', pct > 90);
  $('#quotaText').textContent = lim ? `${fmtSize(used)} dari ${fmtSize(lim)} terpakai` : `${fmtSize(used)} terpakai`;
  const au = S.appUsage;
  $('#quotaApp').textContent = au ? `${CFG.APP_NAME}: ${fmtSize(au.total)} (${au.count.toLocaleString('id-ID')} file)` : '';
  $('#quotaFree').textContent = lim ? `Sisa ${fmtSize(Math.max(0, lim - used))}` : '';
  if (au && lim) $('#quotaAppFill').style.width = Math.min(100, au.total / lim * 100) + '%';
  if (S.rootId && S.user) $('#quotaDrive').href = 'https://drive.google.com/drive/folders/' + S.rootId + '?authuser=' + encodeURIComponent(S.user.emailAddress);
}

/* ================================================================ PILIHAN */
function toggleSelect(id) {
  if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
  const el = $(`.item[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.toggle('selected', S.selected.has(id));
    const c = el.querySelector('[data-check]'); if (c) c.setAttribute('aria-pressed', S.selected.has(id));
  }
  renderSelection();
}
function clearSelection() { S.selected.clear(); render(); }
function renderSelection() {
  const n = S.selected.size, trash = S.route.type === 'trash';
  $('#selectionBar').hidden = !n;
  $('#content').classList.toggle('selecting', n > 0);
  $('#selCount').textContent = n + ' dipilih';
  for (const b of $$('#selectionBar [data-hide-in]')) b.hidden = trash;
  for (const b of $$('#selectionBar [data-show-in]')) b.hidden = !trash;
}
const selectedItems = () => S.items.filter(f => S.selected.has(f.id));
const itemById = (id) => S.items.find(f => f.id === id);

/* ================================================================ MENU */
function closeMenus() {
  for (const m of ['#menuNew', '#menuItem', '#menuAccount']) $(m).hidden = true;
  $('#btnAccount').setAttribute('aria-expanded', 'false');
}
function placeMenu(menu, x, y, alignRight = false) {
  menu.hidden = false;
  menu.style.left = menu.style.top = '0px';
  const r = menu.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  let left = alignRight ? x - r.width : x;
  let top = y;
  if (left + r.width > vw - 8) left = vw - r.width - 8;
  if (left < 8) left = 8;
  if (top + r.height > vh - 8) top = Math.max(8, y - r.height);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  const first = menu.querySelector('button, a'); if (first) first.focus({ preventScroll: true });
}
function openNewMenu(anchor) {
  closeMenus();
  const r = anchor.getBoundingClientRect();
  const m = $('#menuNew');
  if (anchor.classList.contains('fab')) {
    m.hidden = false;
    const h = m.getBoundingClientRect().height;
    placeMenu(m, r.right, r.top - h - 10, true);
  } else placeMenu(m, r.left, r.bottom + 6);
}

function openItemMenu(id, x, y, alignRight) {
  const f = itemById(id); if (!f) return;
  closeMenus();
  const m = $('#menuItem');
  const folder = isFolder(f);
  let h = '';
  const b = (act, ic, label, cls = '') => `<button role="menuitem" data-item-action="${act}" data-id="${f.id}" class="${cls}">${icon(ic)}${label}</button>`;
  if (S.route.type === 'trash') {
    h += b('select', 'i-check', S.selected.has(f.id) ? 'Batalkan pilihan' : 'Pilih');
    h += b('restore', 'i-restore', 'Pulihkan');
    h += b('delete', 'i-trash', 'Hapus permanen', 'danger');
  } else {
    h += folder ? b('open', 'i-folder', 'Buka') : b('open', 'i-eye', 'Pratinjau');
    if (!folder) h += b('download', 'i-download', 'Unduh');
    h += b('share', 'i-link', f.shared ? 'Kelola link berbagi' : 'Bagikan link');
    h += '<hr>';
    h += b('rename', 'i-edit', 'Ganti nama');
    h += b('move', 'i-move', 'Pindahkan');
    h += b('star', 'i-star', f.starred ? 'Hapus bintang' : 'Beri bintang');
    if (S.route.type !== 'folder') h += b('reveal', 'i-folder', 'Tampilkan di folder');
    h += `<a role="menuitem" href="${esc(f.webViewLink || '#')}" target="_blank" rel="noopener">${icon('i-external')}Buka di Google Drive</a>`;
    h += '<hr>';
    h += b('select', 'i-check', S.selected.has(f.id) ? 'Batalkan pilihan' : 'Pilih beberapa');
    h += b('trash', 'i-trash', 'Hapus', 'danger');
  }
  m.innerHTML = h;
  placeMenu(m, x, y, alignRight);
}

async function itemAction(act, id) {
  const f = itemById(id); if (!f) return;
  closeMenus();
  switch (act) {
    case 'select': return toggleSelect(f.id);
    case 'open': return openItem(f);
    case 'download': return downloadFiles([f]);
    case 'share': return openShare(f);
    case 'rename': return renameItem(f);
    case 'move': return openMove([f]);
    case 'star': return toggleStar(f);
    case 'reveal': location.hash = folderHash((f.parents && f.parents[0]) || S.rootId); return;
    case 'trash': return trashItems([f]);
    case 'restore': return restoreItems([f]);
    case 'delete': return deleteItems([f]);
  }
}

/* ================================================================ AKSI */
function openItem(f) {
  if (isFolder(f)) { location.hash = folderHash(f.id); return; }
  if (S.route.type === 'trash') { toast('Pulihkan file ini dulu untuk membukanya.'); return; }
  openViewer(f.id);
}

function promptDialog(title, value, okLabel) {
  return new Promise((resolve) => {
    const d = $('#dlgPrompt');
    $('#promptTitle').textContent = title;
    $('#promptOk').textContent = okLabel;
    const inp = $('#promptInput');
    inp.value = value || '';
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? inp.value.trim() : null);
    d.showModal();
    inp.focus();
    const dot = value ? value.lastIndexOf('.') : -1;
    if (dot > 0) inp.setSelectionRange(0, dot); else inp.select();
  });
}
function confirmDialog(title, text, okLabel) {
  return new Promise((resolve) => {
    const d = $('#dlgConfirm');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = okLabel;
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.showModal();
  });
}

async function newFolder(parentId = curFolderId()) {
  const name = await promptDialog('Folder baru', 'Folder tanpa judul', 'Buat');
  if (!name) return null;
  try {
    const f = await api('/files', { method: 'POST', query: { fields: FIELDS }, body: { name, mimeType: FOLDER, parents: [parentId] } });
    S.meta.set(f.id, { name: f.name, parents: f.parents });
    if (S.route.type === 'folder' && S.route.id === parentId) { S.items.push(f); render(); }
    toast(`Folder “${name}” dibuat.`);
    return f;
  } catch (e) { fail(e, 'Gagal membuat folder'); return null; }
}

async function renameItem(f) {
  const name = await promptDialog('Ganti nama', f.name, 'Simpan');
  if (!name || name === f.name) return;
  try {
    const r = await api('/files/' + f.id, { method: 'PATCH', query: { fields: FIELDS }, body: { name } });
    Object.assign(f, r);
    if (isFolder(f)) S.meta.set(f.id, { name: f.name, parents: f.parents });
    render();
    toast('Nama diganti.');
  } catch (e) { fail(e, 'Gagal mengganti nama'); }
}

async function toggleStar(f) {
  try {
    await api('/files/' + f.id, { method: 'PATCH', query: { fields: 'id' }, body: { starred: !f.starred } });
    f.starred = !f.starred;
    if (S.route.type === 'starred' && !f.starred) S.items = S.items.filter(x => x.id !== f.id);
    render();
    toast(f.starred ? 'Diberi bintang.' : 'Bintang dihapus.');
  } catch (e) { fail(e); }
}

async function runAll(list, fn, conc = 4) {
  const results = []; let i = 0;
  const workers = Array.from({ length: Math.min(conc, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      try { results[idx] = await fn(list[idx]); } catch (e) { results[idx] = e; if (e.auth) throw e; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function trashItems(list) {
  if (!list.length) return;
  try {
    const res = await runAll(list, f => api('/files/' + f.id, { method: 'PATCH', query: { fields: 'id' }, body: { trashed: true } }));
    const ok = list.filter((f, i) => !(res[i] instanceof Error));
    const ids = new Set(ok.map(f => f.id));
    S.items = S.items.filter(f => !ids.has(f.id));
    for (const id of ids) S.selected.delete(id);
    render();
    const failed = list.length - ok.length;
    toast(ok.length === 1 ? `“${ok[0].name}” dipindahkan ke Sampah.` : `${ok.length} item dipindahkan ke Sampah.` + (failed ? ` ${failed} gagal.` : ''), {
      action: 'Urungkan', onAction: async () => { await restoreItems(ok, true); onRoute(true); }, ms: 7000
    });
    refreshQuotaSoon();
  } catch (e) { fail(e, 'Gagal menghapus'); }
}

async function restoreItems(list, quiet) {
  try {
    await runAll(list, f => api('/files/' + f.id, { method: 'PATCH', query: { fields: 'id' }, body: { trashed: false } }));
    if (S.route.type === 'trash') {
      const ids = new Set(list.map(f => f.id));
      S.items = S.items.filter(f => !ids.has(f.id)); S.selected.clear(); render();
    }
    if (!quiet) toast(list.length === 1 ? `“${list[0].name}” dipulihkan.` : `${list.length} item dipulihkan.`);
  } catch (e) { fail(e, 'Gagal memulihkan'); }
}

async function deleteItems(list, skipConfirm) {
  if (!list.length) return;
  if (!skipConfirm) {
    const ok = await confirmDialog(
      list.length === 1 ? `Hapus “${list[0].name}” selamanya?` : `Hapus ${list.length} item selamanya?`,
      'File akan hilang dari Google Drive dan tidak bisa dipulihkan.', 'Hapus permanen');
    if (!ok) return;
  }
  try {
    await runAll(list, f => api('/files/' + f.id, { method: 'DELETE' }));
    const ids = new Set(list.map(f => f.id));
    S.items = S.items.filter(f => !ids.has(f.id)); S.selected.clear(); render();
    toast(list.length === 1 ? 'Dihapus permanen.' : `${list.length} item dihapus permanen.`);
    refreshQuotaSoon();
  } catch (e) { fail(e, 'Gagal menghapus'); }
}

async function emptyTrash() {
  const list = S.items;
  if (!list.length) { toast('Sampah sudah kosong.'); return; }
  const ok = await confirmDialog('Kosongkan sampah?', `${list.length} item akan dihapus selamanya dari Google Drive.`, 'Kosongkan');
  if (ok) deleteItems(list, true);
}

/* ---------------------------------------------------------------- unduh */
async function fetchBlob(f, signal) {
  const res = await api('/files/' + f.id, { query: { alt: 'media', acknowledgeAbuse: 'false' }, raw: true, signal });
  return res.blob();
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function downloadFiles(list) {
  const files = list.filter(f => !isFolder(f));
  if (list.length !== files.length) toast('Folder tidak bisa diunduh langsung. Buka foldernya lalu pilih file di dalamnya.');
  for (const f of files) {
    if ((f.mimeType || '').startsWith('application/vnd.google-apps.')) {
      window.open(f.webViewLink, '_blank', 'noopener'); continue;
    }
    toast(`Menyiapkan “${f.name}”…`, { ms: 2500 });
    try { saveBlob(await fetchBlob(f), f.name); }
    catch (e) { fail(e, 'Gagal mengunduh ' + f.name); }
  }
}

/* ---------------------------------------------------------------- bagikan */
let shareItem = null;
async function openShare(f) {
  shareItem = f;
  $('#shareName').textContent = f.name;
  $('#shareToggle').checked = !!f.shared;
  $('#shareToggle').disabled = true;
  $('#shareLink').value = f.webViewLink || '';
  updateShareUI(false);
  $('#dlgShare').showModal();
  try {
    const r = await api('/files/' + f.id, { query: { fields: 'id,webViewLink,permissions(id,type,role)' } });
    const anyone = (r.permissions || []).some(p => p.type === 'anyone');
    f.webViewLink = r.webViewLink; f.shared = anyone;
    $('#shareToggle').checked = anyone;
    $('#shareLink').value = r.webViewLink || '';
    updateShareUI(anyone);
  } catch (e) { fail(e); }
  $('#shareToggle').disabled = false;
}
function updateShareUI(on) {
  $('#shareState').textContent = on ? 'Siapa pun yang punya link bisa melihat' : 'Hanya Anda yang bisa membuka';
  $('#shareLinkRow').hidden = !on;
}
async function setShared(on) {
  const f = shareItem; if (!f) return;
  $('#shareToggle').disabled = true;
  try {
    if (on) await api(`/files/${f.id}/permissions`, { method: 'POST', query: { fields: 'id' }, body: { type: 'anyone', role: 'reader' } });
    else await api(`/files/${f.id}/permissions/anyoneWithLink`, { method: 'DELETE' });
    f.shared = on;
    updateShareUI(on);
    if (on) copyLink(); else toast('Link berbagi dimatikan.');
    if (S.route.type === 'shared' && !on) { S.items = S.items.filter(x => x.id !== f.id); render(); }
  } catch (e) {
    $('#shareToggle').checked = !on;
    fail(e, 'Gagal mengubah akses');
  }
  $('#shareToggle').disabled = false;
}
async function copyLink() {
  const v = $('#shareLink').value;
  try { await navigator.clipboard.writeText(v); toast('Link disalin.'); }
  catch { $('#shareLink').select(); toast('Tekan Ctrl+C untuk menyalin link.'); }
}

/* ---------------------------------------------------------------- pindahkan */
const MV = { items: [], at: null };
async function openMove(list) {
  if (!list.length) return;
  MV.items = list;
  MV.at = S.route.type === 'folder' ? S.route.id : S.rootId;
  $('#moveWhat').textContent = list.length === 1 ? `“${list[0].name}”` : `${list.length} item`;
  $('#dlgMove').returnValue = '';
  $('#dlgMove').showModal();
  loadMoveList();
}
async function loadMoveList() {
  const ul = $('#moveList');
  ul.innerHTML = '<li class="hint">Memuat…</li>';
  const moving = new Set(MV.items.map(f => f.id));
  const at = MV.at;
  const chain = at === S.rootId ? [] : await folderChain(at);
  let ch = `<button type="button" data-move-go="${S.rootId}">File saya</button>`;
  chain.forEach((c, i) => {
    ch += `<span class="sep">${icon('i-chevron-right')}</span>`;
    ch += i === chain.length - 1 ? `<span class="current">${esc(c.name)}</span>` : `<button type="button" data-move-go="${c.id}">${esc(c.name)}</button>`;
  });
  if (!chain.length) ch = `<span class="current">File saya</span>`;
  $('#moveCrumbs').innerHTML = ch;
  try {
    const folders = (await listAll(`'${qstr(at)}' in parents and mimeType='${FOLDER}' and trashed=false`, { orderBy: 'name' }));
    if (MV.at !== at) return;
    for (const f of folders) S.meta.set(f.id, { name: f.name, parents: f.parents });
    ul.innerHTML = folders.length ? folders.map(f => `<li><button type="button" data-move-go="${f.id}" ${moving.has(f.id) ? 'disabled title="Tidak bisa memindahkan folder ke dalam dirinya sendiri"' : ''}>${icon('i-folder')}<span>${esc(f.name)}</span><span class="chev">${icon('i-chevron-right')}</span></button></li>`).join('')
      : '<li class="hint">Tidak ada subfolder. Anda bisa memindahkan ke sini.</li>';
  } catch (e) { ul.innerHTML = '<li class="hint">Gagal memuat folder.</li>'; fail(e); }
  const same = MV.items.every(f => (f.parents || [])[0] === at);
  const inside = chain.some(c => moving.has(c.id));
  $('#moveOk').disabled = same || inside;
}
async function doMove() {
  const target = MV.at, list = MV.items;
  try {
    await runAll(list, f => api('/files/' + f.id, { method: 'PATCH', query: {
      addParents: target, removeParents: (f.parents || []).join(','), fields: 'id,parents' } }));
    for (const f of list) { f.parents = [target]; if (isFolder(f)) S.meta.set(f.id, { name: f.name, parents: [target] }); }
    const name = target === S.rootId ? 'File saya' : (S.meta.get(target) || {}).name || 'folder';
    toast(list.length === 1 ? `Dipindahkan ke “${name}”.` : `${list.length} item dipindahkan ke “${name}”.`, {
      action: 'Buka', onAction: () => location.hash = folderHash(target) });
    if (S.route.type === 'folder' && S.route.id !== target) {
      const ids = new Set(list.map(f => f.id));
      S.items = S.items.filter(f => !ids.has(f.id));
    }
    S.selected.clear(); render();
  } catch (e) { fail(e, 'Gagal memindahkan'); }
}

/* ================================================================ PRATINJAU */
const V = { id: null, url: null, ctl: null };
function viewerFiles() { return visibleFiles(); }
async function openViewer(id) {
  const f = itemById(id); if (!f) return;
  V.id = id;
  if (V.ctl) V.ctl.abort();
  if (V.url) { URL.revokeObjectURL(V.url); V.url = null; }
  const list = viewerFiles();
  const idx = list.findIndex(x => x.id === id);
  $('.viewer-nav.prev').hidden = idx <= 0;
  $('.viewer-nav.next').hidden = idx < 0 || idx >= list.length - 1;
  $('#viewerName').textContent = f.name;
  $('#viewerMeta').textContent = [fmtSize(f.size), fmtDate(f.modifiedTime)].filter(Boolean).join(', ');
  $('#viewerOpenDrive').href = f.webViewLink || '#';
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  const body = $('#viewerBody');
  const k = kindOf(f), size = Number(f.size) || 0, e = extOf(f);
  const msg = (text) => {
    body.innerHTML = `<div class="viewer-msg">${icon(KIND_ICON[k], 'i i-xl')}<p>${esc(text)}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <button class="btn btn-primary" data-action="viewer-download">${icon('i-download')}Unduh</button>
        <a class="btn" href="${esc(f.webViewLink || '#')}" target="_blank" rel="noopener">Buka di Google Drive</a></div></div>`;
  };
  if ((f.mimeType || '').startsWith('application/vnd.google-apps.')) return msg('File Google ini dibuka di Google Drive.');
  const limits = { image: 40e6, video: 250e6, audio: 120e6, pdf: 60e6, code: 3e6 };
  const textual = k === 'code' || (f.mimeType || '').startsWith('text/') || ['txt', 'md', 'csv', 'log'].includes(e);
  const kk = textual ? 'code' : k;
  if (!limits[kk]) return msg('Pratinjau belum tersedia untuk jenis file ini.');
  if (size > limits[kk]) return msg('File ini terlalu besar untuk dipratinjau di sini.');
  body.innerHTML = '<div class="spinner"></div>';
  V.ctl = new AbortController();
  try {
    const blob = await fetchBlob(f, V.ctl.signal);
    if (V.id !== id) return;
    if (kk === 'code') {
      const t = await blob.text();
      body.innerHTML = '<pre></pre>'; body.firstChild.textContent = t;
      return;
    }
    const typed = blob.type && blob.type !== 'application/octet-stream' ? blob : new Blob([blob], { type: f.mimeType || (kk === 'pdf' ? 'application/pdf' : '') });
    V.url = URL.createObjectURL(typed);
    if (kk === 'image') body.innerHTML = `<img alt="${esc(f.name)}" src="${V.url}">`;
    else if (kk === 'video') body.innerHTML = `<video controls autoplay playsinline src="${V.url}"></video>`;
    else if (kk === 'audio') body.innerHTML = `<audio controls autoplay src="${V.url}"></audio>`;
    else if (kk === 'pdf') body.innerHTML = `<iframe title="${esc(f.name)}" src="${V.url}"></iframe>`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (V.id === id) msg(err.auth ? 'Sesi Google habis. Sambungkan lagi lalu coba buka file ini.' : 'File tidak bisa dimuat: ' + err.message);
  }
}
function closeViewer() {
  if (V.ctl) V.ctl.abort();
  if (V.url) { URL.revokeObjectURL(V.url); V.url = null; }
  V.id = null;
  $('#viewerBody').innerHTML = '';
  $('#viewer').hidden = true;
  document.body.style.overflow = '';
}
function stepViewer(d) {
  const list = viewerFiles();
  const i = list.findIndex(x => x.id === V.id);
  const n = list[i + d];
  if (n) openViewer(n.id);
}

/* ================================================================ UNGGAH */
const U = { tasks: [], active: 0, max: 3, seq: 0, folderCache: new Map() };

function addUploads(entries, baseParent) {
  // entries: [{file, dir: ['A','B']}]
  if (!entries.length) return;
  for (const en of entries) {
    U.tasks.push({ id: ++U.seq, file: en.file, dir: en.dir || [], base: baseParent, status: 'queued', loaded: 0, xhr: null, error: '' });
  }
  $('#uploads').hidden = false;
  $('#uploads').classList.remove('min');
  renderUploads();
  pumpUploads();
}

function pumpUploads() {
  while (U.active < U.max) {
    const t = U.tasks.find(x => x.status === 'queued');
    if (!t) break;
    runUpload(t);
  }
  renderUploads();
}

async function ensureFolderPath(base, parts) {
  let parent = base;
  for (const name of parts) {
    const key = parent + '/' + name;
    if (!U.folderCache.has(key)) {
      U.folderCache.set(key, (async () => {
        const ex = await api('/files', { query: { q: `name='${qstr(name)}' and '${qstr(parent)}' in parents and mimeType='${FOLDER}' and trashed=false`, fields: 'files(id)', pageSize: 1 } });
        if (ex.files && ex.files[0]) return ex.files[0].id;
        const f = await api('/files', { method: 'POST', query: { fields: 'id,name,parents' }, body: { name, mimeType: FOLDER, parents: [parent] } });
        S.meta.set(f.id, { name: f.name, parents: f.parents });
        landedIn(parent);
        return f.id;
      })().catch(e => { U.folderCache.delete(key); throw e; }));
    }
    parent = await U.folderCache.get(key);
  }
  return parent;
}

async function runUpload(t) {
  t.status = 'uploading'; t.loaded = 0; t.error = '';
  U.active++;
  try {
    const parent = await ensureFolderPath(t.base, t.dir);
    await sendFile(t, parent);
    t.status = 'done';
    landedIn(parent);
  } catch (e) {
    if (e.aborted) t.status = 'cancelled';
    else { t.status = 'failed'; t.error = e.auth ? 'Sesi Google habis' : e.message; }
  }
  U.active--;
  pumpUploads();
  if (!U.tasks.some(x => x.status === 'queued' || x.status === 'uploading')) {
    refreshQuotaSoon();
    const done = U.tasks.filter(x => x.status === 'done').length;
    const failed = U.tasks.filter(x => x.status === 'failed').length;
    if (done && !failed) toast(done === 1 ? 'Unggahan selesai.' : `${done} file selesai diunggah.`);
  }
}

function sendFile(t, parentId) {
  return new Promise(async (resolve, reject) => {
    const file = t.file;
    const type = file.type || 'application/octet-stream';
    const meta = { name: file.name, parents: [parentId] };
    if (file.lastModified) meta.modifiedTime = new Date(file.lastModified).toISOString();
    let token;
    try { token = await getToken(); } catch (e) { return reject(e); }
    let loc = null;
    // 1) coba unggahan "resumable" (stabil untuk file besar)
    try {
      const r = await fetch(`${UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
        body: JSON.stringify(meta),
      });
      if (r.status === 401) { S.token = null; return reject(new Error('Akses kedaluwarsa, coba lagi')); }
      if (r.ok) loc = r.headers.get('Location');
      else if (r.status === 403) {
        let m = 'Ditolak Google Drive'; try { m = (await r.json()).error.message; } catch {}
        if (/quota/i.test(m)) m = 'Ruang Google Drive sudah penuh';
        return reject(new Error(m));
      }
    } catch { /* lanjut ke multipart */ }
    if (t.status === 'cancelled') return reject(Object.assign(new Error('Dibatalkan'), { aborted: true }));

    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    if (loc) {
      xhr.open('PUT', loc);
      xhr.setRequestHeader('Content-Type', type);
    } else {
      // 2) cadangan: multipart
      const b = 'vena' + Math.random().toString(36).slice(2);
      xhr.open('POST', `${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}`);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + b);
      t._body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, file, `\r\n--${b}--`]);
    }
    let last = 0;
    xhr.upload.onprogress = (e) => {
      t.loaded = e.loaded / (e.total || 1) * file.size;
      const now = Date.now();
      if (now - last > 150) { last = now; renderUploadRow(t); }
    };
    xhr.onload = () => {
      t.xhr = null; t._body = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        t.loaded = file.size;
        try { t.result = JSON.parse(xhr.responseText); } catch {}
        resolve(t.result);
      } else if (xhr.status === 401) { S.token = null; reject(new Error('Akses kedaluwarsa, coba lagi')); }
      else {
        let m = 'Gagal (' + xhr.status + ')';
        try { m = JSON.parse(xhr.responseText).error.message; } catch {}
        reject(new Error(m));
      }
    };
    xhr.onerror = () => { t.xhr = null; reject(new Error('Koneksi terputus')); };
    xhr.onabort = () => { t.xhr = null; reject(Object.assign(new Error('Dibatalkan'), { aborted: true })); };
    xhr.send(loc ? file : t._body);
  });
}

let landTimer; const landed = new Set();
function landedIn(parentId) {
  landed.add(parentId);
  clearTimeout(landTimer);
  landTimer = setTimeout(() => {
    const cur = S.route.type === 'folder' ? S.route.id : null;
    if ((cur && landed.has(cur)) || S.route.type === 'recent') loadView(true);
    landed.clear();
  }, 600);
}

function cancelUpload(id) {
  const t = U.tasks.find(x => x.id === id); if (!t) return;
  if (t.status === 'queued') { t.status = 'cancelled'; renderUploads(); }
  else if (t.status === 'uploading') { t.status = 'cancelled'; if (t.xhr) t.xhr.abort(); }
}
function retryUpload(id) {
  const t = U.tasks.find(x => x.id === id); if (!t) return;
  t.status = 'queued'; pumpUploads();
}

function uploadStateText(t) {
  switch (t.status) {
    case 'queued': return 'Menunggu…';
    case 'uploading': return `${fmtSize(t.loaded)} dari ${fmtSize(t.file.size)}`;
    case 'done': return 'Selesai' + (t.dir.length ? ' — ' + t.dir.join('/') : '');
    case 'failed': return t.error || 'Gagal';
    case 'cancelled': return 'Dibatalkan';
  }
}
function renderUploadRow(t) {
  const li = $(`#uploadsList li[data-u="${t.id}"]`);
  if (!li) return renderUploads();
  li.className = t.status === 'done' ? 'done' : t.status === 'failed' ? 'fail' : '';
  li.querySelector('.u-state').textContent = uploadStateText(t);
  const pct = t.status === 'done' ? 100 : t.file.size ? (t.loaded / t.file.size * 100) : (t.status === 'uploading' ? 50 : 0);
  li.querySelector('.u-bar span').style.width = pct + '%';
  let act = '';
  if (t.status === 'queued' || t.status === 'uploading') act = `<button class="icon-btn" data-u-cancel="${t.id}" aria-label="Batalkan">${icon('i-x')}</button>`;
  else if (t.status === 'failed' || t.status === 'cancelled') act = `<button class="icon-btn" data-u-retry="${t.id}" aria-label="Coba lagi">${icon('i-restore')}</button>`;
  else if (t.status === 'done') act = `<span class="icon-btn" style="color:var(--accent)">${icon('i-check')}</span>`;
  const box = li.querySelector('.u-act');
  if (box.dataset.s !== t.status) { box.innerHTML = act; box.dataset.s = t.status; }
  renderUploadTitle();
}
function renderUploadTitle() {
  const all = U.tasks.filter(x => x.status !== 'cancelled');
  const busy = all.filter(x => x.status === 'queued' || x.status === 'uploading').length;
  const done = all.filter(x => x.status === 'done').length;
  const failed = all.filter(x => x.status === 'failed').length;
  $('#uploadsTitle').textContent = busy ? `Mengunggah ${done + 1 > all.length ? all.length : done + 1} dari ${all.length}`
    : failed ? `${failed} unggahan gagal` : `${done} unggahan selesai`;
}
function renderUploads() {
  const ul = $('#uploadsList');
  ul.innerHTML = U.tasks.slice(-200).reverse().map(t => `<li data-u="${t.id}">
      <span class="u-name" title="${esc(t.file.name)}">${esc(t.file.name)}</span>
      <span class="u-act"></span>
      <span class="u-state"></span>
      <span class="u-bar"><span></span></span></li>`).join('');
  for (const t of U.tasks.slice(-200)) renderUploadRow(t);
  renderUploadTitle();
}

function startUpload(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const base = curFolderId();
  addUploads(files.map(f => {
    const rel = f.webkitRelativePath || '';
    const dir = rel ? rel.split('/').slice(0, -1) : [];
    return { file: f, dir };
  }), base);
}

async function entriesFromDrop(dt) {
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map(i => (i.kind === 'file' && i.webkitGetAsEntry) ? i.webkitGetAsEntry() : null).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map(f => ({ file: f, dir: [] }));
  const out = [];
  async function walk(entry, path) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file: f, dir: path });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, [...path, entry.name]);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, []);
  return out;
}

/* ================================================================ SETUP & LOGIN */
function setupLoginScreen() {
  const last = LS.get('vena.lastEmail');
  const allow = allowedEmail();
  const name = LS.get('vena.lastName');
  $('#btnLoginText').textContent = last ? `Lanjutkan sebagai ${name || last}` : 'Masuk dengan Google';
  $('#loginHint').textContent = allow ? `Gunakan akun ${allow}.` : (last ? last : '');
  $('#btnResetSetup').hidden = !!CFG.CLIENT_ID;
}

async function boot() {
  applyTheme();
  for (const el of $$('[data-appname]')) el.textContent = CFG.APP_NAME;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  if (!clientId()) {
    $('#setupOrigin').textContent = location.origin.startsWith('http') ? location.origin : 'https://vena.web.id';
    $('#setupEmail').value = allowedEmail();
    show('screenSetup');
    return;
  }
  try { await waitForGis(); }
  catch (e) { show('screenLogin'); setupLoginScreen(); $('#loginError').textContent = e.message; return; }
  initTokenClient();
  setupLoginScreen();
  // sesi tersimpan masih berlaku?
  loadSession();
  if (S.token || (brokerMode() && S.bsession)) {
    try { await afterLogin(); return; }
    catch (e) {
      if (!$('#screenLink').hidden) return;      // Drive penyimpanan belum terhubung
      if (!e.auth) console.warn(e);
      clearSession();
    }
  }
  show('screenLogin');
}

/* ================================================================ EVENT */
function bind() {
  $('#setupSave').onclick = () => {
    const id = $('#setupClientId').value.trim();
    const em = $('#setupEmail').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(id)) {
      $('#setupError').textContent = 'Client ID harus berakhiran .apps.googleusercontent.com';
      return;
    }
    LS.set('vena.clientId', id);
    if (em) LS.set('vena.allowedEmail', em.toLowerCase()); else LS.del('vena.allowedEmail');
    show('screenLoading');
    boot();
  };
  $('#btnResetSetup').onclick = () => { LS.del('vena.clientId'); LS.del('vena.session'); location.reload(); };
  $('#btnLogin').onclick = () => signIn(LS.get('vena.lastEmail') ? '' : 'select_account');
  $('#btnLink').onclick = linkStorage;
  $('#btnTheme').onclick = toggleTheme;

  $('#btnAccount').onclick = (e) => {
    e.stopPropagation();
    const m = $('#menuAccount'), open = m.hidden;
    closeMenus();
    m.hidden = !open;
    $('#btnAccount').setAttribute('aria-expanded', String(open));
  };

  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/';
    $('#searchInput').blur();
  };
  $('#sortSelect').onchange = (e) => { S.sort = e.target.value; LS.set('vena.sort', S.sort); render(); };
  for (const b of $$('.seg button')) b.onclick = () => { S.view = b.dataset.view; LS.set('vena.view', S.view); render(); };

  $('#pickFiles').onchange = (e) => { startUpload(e.target.files); e.target.value = ''; };
  $('#pickFolder').onchange = (e) => { startUpload(e.target.files); e.target.value = ''; };

  $('#shareToggle').onchange = (e) => setShared(e.target.checked);
  $('#dlgMove').addEventListener('close', () => { if ($('#dlgMove').returnValue === 'ok') doMove(); });

  window.addEventListener('hashchange', () => { if (!$('#viewer').hidden) closeViewer(); onRoute(); });
  window.addEventListener('beforeunload', (e) => {
    if (U.tasks.some(t => t.status === 'uploading' || t.status === 'queued')) { e.preventDefault(); e.returnValue = ''; }
  });

  /* klik global (delegasi) */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    // aksi menu item
    const ia = t.closest('[data-item-action]');
    if (ia) { itemAction(ia.dataset.itemAction, ia.dataset.id); return; }
    const go = t.closest('[data-go]');
    if (go) { location.hash = folderHash(go.dataset.go); return; }
    const mg = t.closest('[data-move-go]');
    if (mg && !mg.disabled) { MV.at = mg.dataset.moveGo; loadMoveList(); return; }
    const uc = t.closest('[data-u-cancel]'); if (uc) { cancelUpload(Number(uc.dataset.uCancel)); return; }
    const ur = t.closest('[data-u-retry]'); if (ur) { retryUpload(Number(ur.dataset.uRetry)); return; }

    const a = t.closest('[data-action]');
    if (a) {
      const act = a.dataset.action;
      if (act !== 'open-new') closeMenus();
      switch (act) {
        case 'open-new': e.stopPropagation(); { const open = !$('#menuNew').hidden; closeMenus(); if (!open) openNewMenu(a); } return;
        case 'upload-files': $('#pickFiles').click(); return;
        case 'upload-folder': $('#pickFolder').click(); return;
        case 'new-folder': newFolder(); return;
        case 'open-sidebar': $('#screenApp').classList.add('nav-open'); return;
        case 'close-sidebar': $('#screenApp').classList.remove('nav-open'); return;
        case 'logout': logout(); return;
        case 'theme': toggleTheme(); return;
        case 'reconnect': reconnect(); return;
        case 'home': location.hash = '#/'; return;
        case 'retry': loadView(); return;
        case 'clear-selection': clearSelection(); return;
        case 'sel-download': downloadFiles(selectedItems()); return;
        case 'sel-move': openMove(selectedItems()); return;
        case 'sel-trash': trashItems(selectedItems()); return;
        case 'sel-restore': restoreItems(selectedItems()); return;
        case 'sel-delete': deleteItems(selectedItems()); return;
        case 'empty-trash': emptyTrash(); return;
        case 'copy-link': copyLink(); return;
        case 'move-newfolder': {
          const f = await newFolder(MV.at);
          if (f) { MV.at = f.id; loadMoveList(); }
          return;
        }
        case 'close-viewer': closeViewer(); return;
        case 'viewer-prev': stepViewer(-1); return;
        case 'viewer-next': stepViewer(1); return;
        case 'viewer-download': { const f = itemById(V.id); if (f) downloadFiles([f]); return; }
        case 'viewer-share': { const f = itemById(V.id); if (f) openShare(f); return; }
        case 'toggle-uploads': $('#uploads').classList.toggle('min'); return;
        case 'close-uploads': {
          if (U.tasks.some(x => x.status === 'uploading' || x.status === 'queued')) {
            const ok = await confirmDialog('Batalkan unggahan?', 'Unggahan yang belum selesai akan dihentikan.', 'Batalkan unggahan');
            if (!ok) return;
            for (const x of U.tasks) cancelUpload(x.id);
          }
          U.tasks = []; $('#uploads').hidden = true; return;
        }
      }
    }

    // item di daftar
    const item = t.closest('#content .item');
    if (item) {
      const id = item.dataset.id;
      if (t.closest('[data-check]')) { e.stopPropagation(); toggleSelect(id); return; }
      if (t.closest('[data-more]')) {
        e.stopPropagation();
        const r = t.closest('[data-more]').getBoundingClientRect();
        openItemMenu(id, r.right, r.bottom + 4, true);
        return;
      }
      if (S.selected.size || e.ctrlKey || e.metaKey || e.shiftKey) { toggleSelect(id); return; }
      const f = itemById(id); if (f) openItem(f);
      return;
    }

    // klik di luar menu menutupnya
    if (!t.closest('.menu')) closeMenus();
  });

  document.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('#content .item');
    if (!item) return;
    e.preventDefault();
    openItemMenu(item.dataset.id, e.clientX, e.clientY, false);
  });

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!$('#viewer').hidden) {
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') stepViewer(-1);
      else if (e.key === 'ArrowRight') stepViewer(1);
      return;
    }
    if (e.key === 'Escape') {
      if ([...$$('.menu')].some(m => !m.hidden)) { closeMenus(); return; }
      if (S.selected.size) clearSelection();
      $('#screenApp').classList.remove('nav-open');
      return;
    }
    if (typing || $('#screenApp').hidden || document.querySelector('dialog[open]')) return;
    const item = document.activeElement.closest && document.activeElement.closest('#content .item');
    if (e.key === 'Enter' && item) { const f = itemById(item.dataset.id); if (f) openItem(f); }
    if (e.key === ' ' && item) { e.preventDefault(); toggleSelect(item.dataset.id); }
    if (e.key === 'Delete' && S.selected.size) {
      if (S.route.type === 'trash') deleteItems(selectedItems()); else trashItems(selectedItems());
    }
    if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
  });

  /* seret & lepas */
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || $('#screenApp').hidden) return;
    e.preventDefault();
    dragDepth++;
    const name = S.route.type === 'folder' && S.route.id !== S.rootId ? ((S.meta.get(S.route.id) || {}).name || 'folder ini') : 'File saya';
    $('#dropTarget').textContent = name;
    $('#dropZone').hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropZone').hidden = true; });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('#dropZone').hidden = true;
    if ($('#screenApp').hidden) return;
    const base = curFolderId();
    const entries = await entriesFromDrop(e.dataTransfer);
    addUploads(entries, base);
  });

  // tempel file dari clipboard (mis. tangkapan layar)
  document.addEventListener('paste', (e) => {
    if ($('#screenApp').hidden || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const files = [...(e.clipboardData && e.clipboardData.files || [])];
    if (files.length) startUpload(files);
  });
}

/* ---------------------------------------------------------------- service worker (PWA) */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
}

bind();
boot();
})();
