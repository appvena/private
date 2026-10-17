/* =====================================================================
   VENA — aplikasi penyimpanan pribadi di atas Google Drive
   Tanpa server: browser langsung bicara ke Google Drive API memakai
   token OAuth dari Google Identity Services.
   ===================================================================== */
(() => {
'use strict';

/* ---------------------------------------------------------------- konfigurasi */
const CFG = Object.assign({
  CLIENT_ID: '', ALLOWED_EMAIL: '', SERVER_URL: '', BROKER_URL: '', STORAGE_EMAIL: '', ROOT_FOLDER_NAME: 'Vena Drive', APP_NAME: 'Vena'
}, window.VENA_CONFIG || {});
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const clientId = () => (CFG.CLIENT_ID || LS.get('vena.clientId') || '').trim();
// Akun yang boleh login. Tanpa penjaga (BROKER_URL kosong), akun login = akun penyimpanan.
const allowedEmail = () => (CFG.STORAGE_EMAIL || CFG.ALLOWED_EMAIL || LS.get('vena.allowedEmail') || '').trim().toLowerCase();

// Izin "drive.file": aplikasi HANYA bisa melihat & mengubah file yang dibuat
// lewat aplikasi ini sendiri. File lain di Google Drive tidak terjangkau sama sekali.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink,starred,webViewLink,parents,shared,trashed,explicitlyTrashed,fileExtension,appProperties';

/* ---------------------------------------------------------------- state */
const S = {
  token: null, exp: 0, bsession: null, user: null, quota: null, rootId: null,
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
  for (const s of ['screenLoading', 'screenSetup', 'screenLogin', 'screenApp']) $('#' + s).hidden = s !== id;
}

/* ================================================================ AUTENTIKASI
   Dua mode:
   - Mode PASSWORD (SERVER_URL diisi): masuk cukup dengan password Vena.
     Server kecil di Google Apps Script (milik akun penyimpanan) memeriksa
     password, lalu memberi akses sementara ke Drive. Tanpa HP, tanpa akun Google.
   - Mode GOOGLE (SERVER_URL kosong): masuk dengan akun Google penyimpanan.
   ================================================================ */
class AuthError extends Error { constructor() { super('Sesi habis'); this.auth = true; } }
const serverUrl = () => (CFG.SERVER_URL || CFG.BROKER_URL || '').trim();
const brokerMode = () => !!serverUrl();

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
  tokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId(), scope: DRIVE_SCOPE, callback: () => {} });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error_description || r.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE))
        return reject(new Error('Akses ke Google Drive belum diizinkan. Masuk lagi dan centang izin Google Drive.'));
      resolve(r);
    };
    tokenClient.error_callback = (e) => {
      const map = {
        popup_closed: 'Jendela login ditutup sebelum selesai.',
        popup_failed_to_open: 'Jendela login diblokir browser. Izinkan pop-up untuk situs ini, lalu coba lagi.',
      };
      reject(new Error(map[e.type] || e.message || e.type));
    };
    const hint = allowedEmail() || LS.get('vena.lastEmail') || '';
    const opts = { prompt };
    if (hint) opts.login_hint = hint;
    tokenClient.requestAccessToken(opts);
  });
}

/* ---- server Vena (Apps Script) ---- */
async function server(action, data = {}) {
  let res;
  try {
    res = await fetch(serverUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // tanpa preflight CORS
      body: JSON.stringify(Object.assign({ action }, data)),
    });
  } catch {
    throw new Error('Server Vena tidak bisa dihubungi. Periksa koneksi internet.');
  }
  let j;
  try { j = await res.json(); }
  catch { throw new Error('Balasan server Vena tidak valid. Pastikan Apps Script di-deploy sebagai Web app dengan akses "Anyone".'); }
  if (j.error) { const e = new Error(j.message || j.error); e.code = j.error; throw e; }
  return j;
}

/* ---- sesi lokal ---- */
function saveSession(persist) {
  const data = JSON.stringify({ token: S.token, exp: S.exp, bs: S.bsession });
  const remember = persist !== undefined ? persist : !(S.bsession && S.bsession.temp);
  if (remember) { LS.set('vena.session', data); try { sessionStorage.removeItem('vena.session'); } catch {} }
  else { try { sessionStorage.setItem('vena.session', data); } catch {} LS.del('vena.session'); }
}
function loadSession() {
  let raw = LS.get('vena.session');
  if (!raw) { try { raw = sessionStorage.getItem('vena.session'); } catch {} }
  try {
    const s = JSON.parse(raw || 'null');
    if (!s) return;
    if (s.token && s.exp > Date.now() + 30000) { S.token = s.token; S.exp = s.exp; }
    if (s.bs && s.bs.exp > Date.now()) S.bsession = s.bs;
  } catch {}
}
function setToken(r) {
  S.token = r.access_token;
  S.exp = Date.now() + (Number(r.expires_in || 1800) - 60) * 1000;
  saveSession();
}
function clearSession() {
  S.token = null; S.exp = 0; S.bsession = null;
  LS.del('vena.session');
  try { sessionStorage.removeItem('vena.session'); } catch {}
}
function expireSession() {
  clearSession();
  if (!$('#screenApp').hidden) {
    if (brokerMode()) { toast('Sesi berakhir. Masuk lagi dengan password.', { error: true }); logout(); }
    else $('#sessionBanner').hidden = false;
  }
}

/* ---- token Drive yang selalu segar ---- */
let tokenPromise = null;
async function getToken(force = false) {
  if (!force && S.token && Date.now() < S.exp) return S.token;
  if (!brokerMode() || !S.bsession || Date.now() > S.bsession.exp) { expireSession(); throw new AuthError(); }
  if (!tokenPromise) {
    tokenPromise = (async () => {
      try {
        setToken(await server('token', { session: S.bsession.id }));
        return S.token;
      } catch (e) {
        if (e.code === 'AUTH') { expireSession(); throw new AuthError(); }
        throw e;
      }
    })().finally(() => { tokenPromise = null; });
  }
  return tokenPromise;
}

/* ---- masuk ---- */
async function passwordLogin(e) {
  e.preventDefault();
  const pw = $('#pwInput').value;
  const remember = $('#pwRemember').checked;
  $('#loginError').textContent = '';
  if (!pw) { $('#loginError').textContent = 'Ketik password Anda.'; $('#pwInput').focus(); return; }
  const btn = $('#pwSubmit');
  btn.disabled = true; btn.textContent = 'Memeriksa…';
  try {
    const res = await server('login', { password: pw, remember });
    S.bsession = { id: res.session, exp: Date.now() + (Number(res.session_ttl) - 120) * 1000, temp: !remember };
    setToken(res.drive);
    LS.set('vena.remember', remember ? '1' : '0');
    $('#pwInput').value = '';
    await afterLogin();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#pwInput').select();
  } finally {
    btn.disabled = false; btn.textContent = 'Masuk';
  }
}

async function signIn(prompt) {
  $('#loginError').textContent = '';
  $('#btnLogin').disabled = true;
  try {
    setToken(await requestToken(prompt));
    await afterLogin();
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
  }
  LS.set('vena.lastEmail', email);
  LS.set('vena.lastName', about.user.displayName || '');
  S.user = about.user;
  S.quota = about.storageQuota;
  $('#sessionBanner').hidden = true;
  renderAccount();
  renderQuota();
  const dp = LS.get('vena.details');
  $('#win').classList.toggle('no-details', dp === '0');
  $('#btnDetails').setAttribute('aria-pressed', String(dp !== '0'));
  show('screenApp');
  await ensureRoot();
  refreshAppUsage();
  onRoute();
}

async function reconnect() {
  if (brokerMode()) { logout(); return; }
  try {
    setToken(await requestToken(''));
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
  if (brokerMode()) setTimeout(() => $('#pwInput').focus(), 50);
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
  const prevKey = S.routeKey;
  S.route = parseHash();
  S.routeKey = location.hash || '#/';
  trackHistory(S.routeKey);
  if (prevKey !== S.routeKey) { S.selected.clear(); S.anchor = null; }
  closeMenus();
  const navKey = S.route.type === 'folder' ? (S.route.id === S.rootId ? 'home' : '') : S.route.type;
  for (const a of $$('.nav a')) a.classList.toggle('active', a.dataset.nav === navKey);
  $('#searchInput').value = S.route.type === 'search' ? S.route.q : '';
  $('#screenApp').classList.remove('nav-open');
  $('#trashNote').hidden = S.route.type !== 'trash';
  const trash = S.route.type === 'trash';
  for (const b of $$('#cmdbar [data-hide-in]')) b.hidden = trash;
  for (const b of $$('#cmdbar [data-show-in]')) b.hidden = !trash;
  $('#sortSelect').disabled = S.route.type === 'recent';
  updateNavButtons();
  renderTree();
  loadView(silent);
}

/* ---- riwayat kembali / maju ---- */
const H = { stack: [], idx: -1, moving: false };
function trackHistory(key) {
  if (H.moving) { H.moving = false; return; }
  if (H.stack[H.idx] === key) return;
  H.stack = H.stack.slice(0, H.idx + 1);
  H.stack.push(key);
  H.idx = H.stack.length - 1;
}
function navStep(d) {
  const i = H.idx + d;
  if (i < 0 || i >= H.stack.length) return;
  H.idx = i; H.moving = true;
  location.hash = H.stack[i];
}
function parentOf(id) {
  if (!id || id === S.rootId) return null;
  const m = S.meta.get(id);
  return (m && m.parents && m.parents[0]) || S.rootId;
}
function navUp() {
  if (S.route.type !== 'folder') { location.hash = '#/'; return; }
  const p = parentOf(S.route.id);
  if (p) location.hash = folderHash(p);
}
function updateNavButtons() {
  $('#navBack').disabled = H.idx <= 0;
  $('#navFwd').disabled = H.idx >= H.stack.length - 1;
  $('#navUp').disabled = S.route.type === 'folder' && S.route.id === S.rootId;
}

async function loadView(silent = false) {
  const seq = ++S.loadSeq;
  const r = S.route;
  renderCrumbs();
  if (!silent) {
    $('#items').innerHTML = '';
    $('#emptyState').hidden = true;
    $('#listLoading').hidden = false;
    renderStatus(); renderDetails();
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
    for (const id of [...S.selected]) if (!items.some(f => f.id === id)) S.selected.delete(id);
    render();
  } catch (e) {
    if (seq !== S.loadSeq) return;
    $('#listLoading').hidden = true;
    S.items = []; render(true);
    if (e.auth) { showEmpty('session'); return; }
    if (e.status === 404) { showEmpty('missing'); return; }
    fail(e, 'Gagal memuat');
    showEmpty('error');
  } finally {
    if (seq === S.loadSeq) $('#listLoading').hidden = true;
  }
}

/* ---------------------------------------------------------------- alamat */
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
const VIEW_TITLES = { recent: 'Terbaru', starred: 'Berbintang', shared: 'Dibagikan', trash: 'Sampah' };
function setTitle(t) {
  $('#winTitle').textContent = t;
  document.title = t + ' — ' + CFG.APP_NAME;
}
async function renderCrumbs() {
  const el = $('#crumbs');
  const r = S.route;
  const root = `<span class="root-ico">${icon('i-drawer')}</span>`;
  const sep = `<span class="sep">${icon('i-chevron-right')}</span>`;
  if (r.type === 'search') { el.innerHTML = root + `<button data-go="${S.rootId}">File saya</button>${sep}<span class="current">Hasil pencarian “${esc(r.q)}”</span>`; setTitle('Cari: ' + r.q); return; }
  if (r.type !== 'folder') { el.innerHTML = root + `<span class="current">${VIEW_TITLES[r.type]}</span>`; setTitle(VIEW_TITLES[r.type]); return; }
  if (r.id === S.rootId) { el.innerHTML = root + `<span class="current">File saya</span>`; setTitle('File saya'); return; }
  const seq = S.loadSeq;
  el.innerHTML = root + `<button data-go="${S.rootId}">File saya</button>${sep}<span class="current">…</span>`;
  const chain = await folderChain(r.id);
  if (seq !== S.loadSeq) return;
  let html = root + `<button data-go="${S.rootId}" data-drop="${S.rootId}">File saya</button>`;
  chain.forEach((c, i) => {
    html += sep;
    html += i === chain.length - 1 ? `<span class="current" title="${esc(c.name)}">${esc(c.name)}</span>` : `<button data-go="${c.id}" data-drop="${c.id}" title="${esc(c.name)}">${esc(c.name)}</button>`;
  });
  el.innerHTML = html;
  el.scrollLeft = el.scrollWidth;
  setTitle(chain.length ? chain[chain.length - 1].name : 'File saya');
  updateNavButtons();
  expandTreeTo(chain.map(c => c.id));
}

/* ================================================================ IKON KHUSUS
   Warna & simbol pilihan sendiri, disimpan di Drive (appProperties)
   supaya sama di semua perangkat. */
const ICON_COLORS = {
  kuning: { label: 'Kuning', front: '#F2C35E', back: '#D99A2B', ink: '#7A4E00' },
  oranye: { label: 'Oranye', front: '#F5A25D', back: '#D97A2E', ink: '#6E3300' },
  merah:  { label: 'Merah',  front: '#EF7B70', back: '#CC4B40', ink: '#6E1209' },
  pink:   { label: 'Pink',   front: '#F28DB8', back: '#D45F92', ink: '#6E1440' },
  ungu:   { label: 'Ungu',   front: '#B49AF0', back: '#8D6FD6', ink: '#35207A' },
  biru:   { label: 'Biru',   front: '#7DB4F5', back: '#4F8DDB', ink: '#0F3A78' },
  toska:  { label: 'Toska',  front: '#5FCFC0', back: '#2FA698', ink: '#064A42' },
  hijau:  { label: 'Hijau',  front: '#8BD07A', back: '#5FAE4C', ink: '#1A5210' },
  abu:    { label: 'Abu-abu', front: '#B9C3C0', back: '#92A09B', ink: '#333D3A' },
  gelap:  { label: 'Gelap',  front: '#5B6764', back: '#3E4946', ink: '#F1F5F3' },
};
const ICON_SYMBOLS = [
  ['musik', 'Musik'], ['foto', 'Foto'], ['video', 'Video'], ['dokumen', 'Dokumen'], ['uang', 'Keuangan'],
  ['kerja', 'Kerja'], ['buku', 'Buku'], ['sekolah', 'Sekolah'], ['hati', 'Favorit'], ['bintang', 'Penting'],
  ['kunci', 'Rahasia'], ['rumah', 'Rumah'], ['jalan', 'Perjalanan'], ['kode', 'Kode'], ['game', 'Game'],
  ['unduh', 'Unduhan'], ['arsip', 'Arsip'], ['orang', 'Pribadi'], ['keluarga', 'Keluarga'], ['mobil', 'Kendaraan'],
  ['makan', 'Makanan'], ['awan', 'Cloud'], ['setel', 'Pengaturan'], ['kalender', 'Jadwal'], ['belanja', 'Belanja'],
  ['sehat', 'Kesehatan'], ['hadiah', 'Hadiah'], ['toko', 'Toko'],
];
const iconPrefs = (f) => {
  const ap = (f && f.appProperties) || {};
  return { color: ICON_COLORS[ap.venaColor] ? ap.venaColor : '', sym: ICON_SYMBOLS.some(s => s[0] === ap.venaIcon) ? ap.venaIcon : '' };
};
const symUse = (sym, x, y, size, ink) => sym
  ? `<use href="#s-${sym}" x="${x}" y="${y}" width="${size}" height="${size}" fill="none" stroke="${ink}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>` : '';

/* ================================================================ IKON */
const KIND_LABEL = { image: 'Gambar', video: 'Video', audio: 'Audio', pdf: 'PDF', sheet: 'Lembar kerja', slides: 'Presentasi', doc: 'Dokumen', archive: 'Arsip', code: 'Teks / kode', file: 'File', folder: 'Folder' };
function folderSvg(cls = 'big', f) {
  const pr = iconPrefs(f);
  const c = pr.color ? ICON_COLORS[pr.color] : null;
  const front = c ? c.front : 'var(--folder-front)', back = c ? c.back : 'var(--folder-back)';
  const ink = c ? c.ink : '#7A4E00';
  return `<svg class="${cls}" viewBox="0 0 64 52" aria-hidden="true">
    <path d="M4 6a4 4 0 0 1 4-4h15l6 6h27a4 4 0 0 1 4 4v4H4z" fill="${back}"/>
    <rect x="2" y="12" width="60" height="38" rx="5" fill="${front}"/>
    <rect x="2" y="12" width="60" height="5" rx="2.5" fill="#fff" opacity=".28"/>
    ${symUse(pr.sym, 21, 20, 22, ink)}</svg>`;
}
function fileSvg(f, cls = 'big') {
  const k = kindOf(f);
  const pr = iconPrefs(f);
  if (pr.sym || pr.color) {
    const c = ICON_COLORS[pr.color || 'biru'];
    const ext = extOf(f).toUpperCase().slice(0, 4);
    return `<svg class="${cls}" viewBox="0 0 52 64" aria-hidden="true">
      <path d="M8 2h25l15 15v41a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z" fill="${c.front}"/>
      <path d="M33 2v11a4 4 0 0 0 4 4h11" fill="${c.back}"/>
      ${pr.sym ? symUse(pr.sym, 13, 16, 24, c.ink) : ''}
      ${ext ? `<text x="26" y="54" text-anchor="middle" font-family="Atkinson Hyperlegible, system-ui, sans-serif" font-weight="700" font-size="9" fill="${c.ink}">${esc(ext)}</text>` : ''}</svg>`;
  }
  let ext = extOf(f).toUpperCase().slice(0, 4);
  if (!ext) ext = { image: 'IMG', video: 'VID', audio: 'AUD', pdf: 'PDF', archive: 'ZIP' }[k] || '';
  const fs = ext.length > 3 ? 8 : 9.5;
  return `<svg class="${cls}" viewBox="0 0 52 64" aria-hidden="true">
    <path d="M8 2h25l15 15v41a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z" fill="var(--paper)" stroke="var(--paper-line)" stroke-width="1.5"/>
    <path d="M33 2v11a4 4 0 0 0 4 4h11" fill="var(--paper-fold)" stroke="var(--paper-line)" stroke-width="1.5" stroke-linejoin="round"/>
    ${ext ? `<rect x="0" y="34" width="38" height="16" rx="4" fill="var(--k-${k})"/>
    <text x="19" y="45.5" text-anchor="middle" font-family="Atkinson Hyperlegible, system-ui, sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${esc(ext)}</text>`
    : `<path d="M13 30h22M13 37h22M13 44h14" stroke="var(--k-${k})" stroke-width="3" stroke-linecap="round"/>`}</svg>`;
}
const itemSvg = (f, cls) => isFolder(f) ? folderSvg(cls, f) : fileSvg(f, cls);
const typeLabel = (f) => isFolder(f) ? 'Folder' : (KIND_LABEL[kindOf(f)] + (extOf(f) ? ' (.' + extOf(f) + ')' : ''));

/* ================================================================ RENDER */
function sorted(list) {
  const a = [...list];
  if (S.route.type === 'recent') return a;
  const byName = (x, y) => x.name.localeCompare(y.name, 'id', { numeric: true, sensitivity: 'base' });
  if (S.sort === 'modified') a.sort((x, y) => (y.modifiedTime || '').localeCompare(x.modifiedTime || '') || byName(x, y));
  else if (S.sort === 'size') a.sort((x, y) => (Number(y.size) || 0) - (Number(x.size) || 0) || byName(x, y));
  else if (S.sort === 'type') a.sort((x, y) => kindOf(x).localeCompare(kindOf(y)) || extOf(x).localeCompare(extOf(y)) || byName(x, y));
  else a.sort(byName);
  // folder selalu di atas, seperti di komputer
  return a.sort((x, y) => (isFolder(y) ? 1 : 0) - (isFolder(x) ? 1 : 0));
}
const visibleItems = () => sorted(S.items);
const visibleFiles = () => visibleItems().filter(f => !isFolder(f));

function render(silentEmpty) {
  const list = visibleItems();
  if (S.route.type === 'folder' && !silentEmpty) syncTreeChildren(S.route.id, S.items.filter(isFolder));
  const trash = S.route.type === 'trash';
  const box = $('#items');
  box.className = 'items ' + S.view;
  $('#content').classList.toggle('listing', S.view === 'list' && list.length > 0);
  box.innerHTML = list.map(f => itemHTML(f, trash)).join('');
  if (!list.length && !silentEmpty) showEmpty(S.route.type); else $('#emptyState').hidden = true;
  hookThumbs();
  for (const b of $$('.seg button')) b.classList.toggle('on', b.dataset.view === S.view);
  for (const b of $$('#listHead button')) b.classList.toggle('on', b.dataset.sort === S.sort && S.route.type !== 'recent');
  $('#sortSelect').value = S.sort;
  renderSelection();
}

function itemHTML(f, trash) {
  const sel = S.selected.has(f.id);
  const k = kindOf(f);
  const thumb = !isFolder(f) && f.thumbnailLink
    ? `<img data-thumb loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(f.thumbnailLink.replace(/=s\d+$/, '=s320'))}">` : '';
  return `<div class="it${sel ? ' selected' : ''}" data-id="${f.id}" tabindex="0" role="option" aria-selected="${sel}" title="${esc(f.name)}"${trash ? '' : ' draggable="true"'}>
    <div class="ic" data-kind="${k}">${thumb || itemSvg(f)}</div>
    <div class="nm"><span class="mini">${itemSvg(f, 'mini-svg')}</span><span class="label">${esc(f.name)}</span>${f.starred ? `<span class="star-badge" title="Berbintang">${icon('i-star')}</span>` : ''}</div>
    ${f.starred ? `<span class="star-badge grid-only" title="Berbintang">${icon('i-star')}</span>` : ''}
    ${f.shared ? `<span class="shared-badge" title="Dibagikan dengan link">${icon('i-link')}</span>` : ''}
    <span class="col c-date">${trash ? '' : esc(fmtDate(f.modifiedTime))}</span>
    <span class="col c-type">${esc(isFolder(f) ? 'Folder' : KIND_LABEL[k])}</span>
    <span class="col c-size">${isFolder(f) ? '' : esc(fmtSize(f.size))}</span>
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
  for (const img of $$('#items img[data-thumb]')) {
    img.onerror = () => {
      const box = img.parentElement;
      const f = itemById(box.closest('.it').dataset.id);
      if (!f) return;
      box.innerHTML = itemSvg(f);
      if (box.dataset.kind === 'image' && Number(f.size) < 6e6) {
        if (thumbObserver) thumbObserver.observe(box); else loadBlobThumb(box);
      }
    };
  }
  for (const box of $$('#items .ic[data-kind="image"]')) {
    if (box.querySelector('img')) continue;
    const id = box.closest('.it').dataset.id;
    const f = itemById(id);
    if (blobThumbs.has(id)) { box.innerHTML = `<img alt="" src="${blobThumbs.get(id)}">`; continue; }
    if (f && Number(f.size) < 6e6 && thumbObserver) thumbObserver.observe(box);
  }
}
async function loadBlobThumb(box) {
  const card = box.closest('.it'); if (!card) return;
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
      box.firstChild.onerror = () => { const f = itemById(id); box.innerHTML = f ? itemSvg(f) : ''; };
    }
  } catch {}
}

function showEmpty(kind) {
  const el = $('#emptyState');
  const states = {
    folder: S.route.id === S.rootId
      ? ['Belum ada file', 'Seret file ke jendela ini, atau klik Unggah. Semua file tersimpan di Google Drive Anda.', 'Unggah file']
      : ['Folder ini kosong', 'Seret file ke jendela ini, atau klik Unggah.', 'Unggah file'],
    recent: ['Belum ada file', 'File yang baru diunggah atau diubah akan muncul di sini.', 'Unggah file'],
    starred: ['Belum ada yang berbintang', 'Klik kanan file atau folder, lalu pilih Beri bintang supaya mudah ditemukan.'],
    shared: ['Belum ada yang dibagikan', 'File dan folder yang Anda bagikan lewat link akan terkumpul di sini.'],
    trash: ['Sampah kosong', 'File yang Anda hapus bisa dipulihkan dari sini selama 30 hari.'],
    search: ['Tidak ada yang cocok', 'Coba kata lain, atau periksa ejaan nama file.'],
    session: ['Sesi sudah habis', 'Sambungkan lagi untuk melihat file Anda.', 'Sambungkan lagi', 'reconnect'],
    missing: ['Folder tidak ditemukan', 'Folder ini mungkin sudah dihapus atau dipindahkan.', 'Kembali ke File saya', 'home'],
    error: ['File tidak bisa dimuat', 'Periksa koneksi internet, lalu coba lagi.', 'Coba lagi', 'retry'],
  };
  const [t, d, cta, act = 'upload-files'] = states[kind] || states.folder;
  el.innerHTML = `<div class="empty-art" aria-hidden="true">${folderSvg('')}</div><h3>${esc(t)}</h3><p>${esc(d)}</p>${cta ? `<button class="btn btn-primary" data-action="${act}">${esc(cta)}</button>` : ''}`;
  el.hidden = false;
}

function renderAccount() {
  const u = S.user;
  $('#accName').textContent = u.displayName || 'Akun Google';
  $('#accEmail').textContent = u.emailAddress;
  $('#accStorage').hidden = false;
  $('#accStorage').textContent = brokerMode() ? 'Masuk dengan password Vena' : 'Masuk dengan akun Google';
  $('#avatarInitial').textContent = (u.displayName || u.emailAddress || '?').trim()[0].toUpperCase();
  const img = $('#avatarImg');
  if (u.photoLink) {
    img.onload = () => { img.hidden = false; $('#avatarInitial').hidden = true; };
    img.onerror = () => { img.hidden = true; $('#avatarInitial').hidden = false; };
    img.src = u.photoLink;
  }
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
  const free = lim ? `${fmtSize(Math.max(0, lim - used))} tersedia` : '';
  $('#quotaFree').textContent = free;
  $('#statusFree').textContent = free ? 'Ruang kosong: ' + fmtSize(Math.max(0, lim - used)) : '';
  if (au && lim) $('#quotaAppFill').style.width = Math.min(100, au.total / lim * 100) + '%';
}

/* ================================================================ PILIHAN */
function paintSelection() {
  for (const el of $$('#items .it')) {
    const on = S.selected.has(el.dataset.id);
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', on);
  }
  renderSelection();
}
function selectOnly(id) { S.selected = new Set([id]); S.anchor = id; paintSelection(); }
function toggleSelect(id) {
  if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
  S.anchor = id; paintSelection();
}
function selectRange(id) {
  const ids = visibleItems().map(f => f.id);
  const a = ids.indexOf(S.anchor), b = ids.indexOf(id);
  if (a < 0 || b < 0) return selectOnly(id);
  S.selected = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  paintSelection();
}
function selectAll() { S.selected = new Set(S.items.map(f => f.id)); paintSelection(); }
function clearSelection() { if (!S.selected.size) return; S.selected.clear(); paintSelection(); }
function renderSelection() {
  const sel = selectedItems();
  const n = sel.length, files = sel.filter(f => !isFolder(f)).length;
  for (const b of $$('#cmdbar [data-need]')) {
    const need = b.dataset.need;
    b.disabled = need === 'one' ? n !== 1 : need === 'files' ? files === 0 : n === 0;
  }
  $('#content').classList.toggle('selecting', n > 0);
  $('#screenApp').classList.toggle('has-sel', n > 0);
  renderStatus();
  renderDetails();
}
function renderStatus() {
  const all = S.items, sel = selectedItems();
  const nF = all.filter(isFolder).length, nFi = all.length - nF;
  const parts = [];
  if (nF) parts.push(`${nF} folder`);
  if (nFi) parts.push(`${nFi} file`);
  $('#statusCount').textContent = parts.length ? parts.join(', ') : 'Kosong';
  if (sel.length) {
    const size = sel.reduce((s, f) => s + (Number(f.size) || 0), 0);
    $('#statusSel').textContent = `${sel.length} dipilih` + (size ? ` (${fmtSize(size)})` : '');
  } else $('#statusSel').textContent = '';
}
const selectedItems = () => S.items.filter(f => S.selected.has(f.id));
const itemById = (id) => S.items.find(f => f.id === id);

/* ---------------------------------------------------------------- panel detail */
function renderDetails() {
  const el = $('#details');
  if (!el || getComputedStyle(el).display === 'none') return;
  const sel = selectedItems();
  const trash = S.route.type === 'trash';
  const btn = (act, ic, label, cls = '') => `<button class="btn ${cls}" data-action="${act}">${icon(ic)}${label}</button>`;
  if (sel.length === 1) {
    const f = sel[0], folder = isFolder(f);
    const k = kindOf(f);
    const prev = !folder && blobThumbs.has(f.id) ? `<img alt="" src="${blobThumbs.get(f.id)}">`
      : !folder && f.thumbnailLink ? `<img alt="" referrerpolicy="no-referrer" src="${esc(f.thumbnailLink.replace(/=s\d+$/, '=s600'))}" onerror="this.replaceWith(document.createRange().createContextualFragment(this.dataset.fb))" data-fb="${esc(itemSvg(f))}">`
      : itemSvg(f);
    let acts = '';
    if (trash) acts = btn('sel-restore', 'i-restore', 'Pulihkan', 'btn-primary') + btn('sel-delete', 'i-trash', 'Hapus permanen', 'danger');
    else acts = btn('sel-open', folder ? 'i-folder' : 'i-eye', folder ? 'Buka folder' : 'Buka', 'btn-primary')
      + (folder ? '' : btn('sel-download', 'i-download', 'Unduh'))
      + btn('sel-share', 'i-link', f.shared ? 'Link aktif' : 'Bagikan')
      + btn('sel-rename', 'i-edit', 'Ganti nama')
      + btn('sel-move', 'i-move', 'Pindahkan')
      + btn('sel-star', 'i-star', f.starred ? 'Lepas bintang' : 'Bintangi')
      + btn('sel-icon', 'i-palette', 'Ubah ikon')
      + btn('sel-trash', 'i-trash', 'Hapus', 'danger');
    el.innerHTML = `<div class="d-preview">${prev}</div>
      <h3>${esc(f.name)}</h3>
      <dl>
        <dt>Jenis</dt><dd>${esc(typeLabel(f))}</dd>
        ${folder ? '' : `<dt>Ukuran</dt><dd>${esc(fmtSize(f.size))}</dd>`}
        <dt>Diubah</dt><dd>${esc(fmtLong(f.modifiedTime))}</dd>
        <dt>Dibuat</dt><dd>${esc(fmtLong(f.createdTime))}</dd>
        <dt>Berbagi</dt><dd>${f.shared ? 'Siapa saja yang punya link' : 'Hanya Anda'}</dd>
      </dl>
      <div class="d-actions">${acts}</div>`;
    return;
  }
  if (sel.length > 1) {
    const size = sel.reduce((s, f) => s + (Number(f.size) || 0), 0);
    const nF = sel.filter(isFolder).length;
    const acts = trash ? btn('sel-restore', 'i-restore', 'Pulihkan', 'btn-primary') + btn('sel-delete', 'i-trash', 'Hapus permanen', 'danger')
      : btn('sel-download', 'i-download', 'Unduh', 'btn-primary') + btn('sel-move', 'i-move', 'Pindahkan') + btn('sel-icon', 'i-palette', 'Ubah ikon') + btn('sel-trash', 'i-trash', 'Hapus', 'danger');
    el.innerHTML = `<div class="d-preview">${folderSvg()}</div>
      <h3>${sel.length} item dipilih</h3>
      <dl>
        ${nF ? `<dt>Folder</dt><dd>${nF}</dd>` : ''}
        <dt>File</dt><dd>${sel.length - nF}</dd>
        <dt>Total</dt><dd>${esc(fmtSize(size))}</dd>
      </dl>
      <div class="d-actions">${acts}</div>`;
    return;
  }
  const title = S.route.type === 'folder' ? ($('#winTitle').textContent || 'File saya') : (VIEW_TITLES[S.route.type] || 'Hasil pencarian');
  const files = S.items.filter(f => !isFolder(f));
  const size = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  el.innerHTML = `<div class="d-preview">${folderSvg()}</div>
    <h3>${esc(title)}</h3>
    <dl>
      <dt>Isi</dt><dd>${S.items.length - files.length} folder, ${files.length} file</dd>
      <dt>Ukuran file</dt><dd>${esc(fmtSize(size))}</dd>
    </dl>
    <p class="d-hint">Klik sekali untuk memilih, klik dua kali untuk membuka. Tahan <kbd>Ctrl</kbd> untuk memilih beberapa, <kbd>Shift</kbd> untuk rentang. Klik kanan untuk pilihan lain.</p>`;
}
function fmtLong(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ---------------------------------------------------------------- pohon folder */
const T = { nodes: new Map(), open: new Set(LS.get('vena.treeOpen') ? JSON.parse(LS.get('vena.treeOpen')) : []) };
// nodes: id -> { name, children: [ids] | null }
function syncTreeChildren(parentId, folders) {
  const kids = sorted(folders).map(f => { T.nodes.set(f.id, Object.assign(T.nodes.get(f.id) || { children: null }, { name: f.name, appProperties: f.appProperties })); return f.id; });
  const p = T.nodes.get(parentId) || { name: '', children: null };
  p.children = kids;
  T.nodes.set(parentId, p);
  renderTree();
}
async function loadTreeChildren(id) {
  try {
    const folders = await listAll(`'${qstr(id)}' in parents and mimeType='${FOLDER}' and trashed=false`, { orderBy: 'name' });
    for (const f of folders) S.meta.set(f.id, { name: f.name, parents: f.parents });
    syncTreeChildren(id, folders.filter(isFolder));
  } catch {}
}
function saveTreeOpen() { LS.set('vena.treeOpen', JSON.stringify([...T.open].slice(-200))); }
function toggleTree(id) {
  if (T.open.has(id)) T.open.delete(id); else { T.open.add(id); const n = T.nodes.get(id); if (!n || !n.children) loadTreeChildren(id); }
  saveTreeOpen(); renderTree();
}
function expandTreeTo(ids) {
  let changed = false;
  for (const id of ids.slice(0, -1)) if (!T.open.has(id)) { T.open.add(id); changed = true; const n = T.nodes.get(id); if (!n || !n.children) loadTreeChildren(id); }
  if (changed) { saveTreeOpen(); renderTree(); }
}
function renderTree() {
  const el = $('#tree'); if (!el || !S.rootId) return;
  const root = T.nodes.get(S.rootId);
  if (!root || !root.children) { el.innerHTML = '<li class="tree-empty">Memuat…</li>'; if (!T.loadingRoot) { T.loadingRoot = true; loadTreeChildren(S.rootId); } return; }
  const cur = S.route.type === 'folder' ? S.route.id : null;
  const branch = (ids, depth) => ids.map(id => {
    const n = T.nodes.get(id); if (!n) return '';
    const open = T.open.has(id) && depth < 12;
    const leaf = n.children && n.children.length === 0;
    return `<li role="treeitem" aria-expanded="${open}">
      <div class="row${cur === id ? ' active' : ''}">
        <button class="twisty${open ? ' open' : ''}${leaf ? ' leaf' : ''}" data-tree-toggle="${id}" aria-label="Buka/tutup">${icon('i-chevron-right')}</button>
        <button class="tname" data-go="${id}" data-drop="${id}" title="${esc(n.name)}">${folderSvg('', n)}<span>${esc(n.name)}</span></button>
      </div>
      ${open && n.children ? `<ul role="group">${branch(n.children, depth + 1)}</ul>` : ''}
    </li>`;
  }).join('');
  el.innerHTML = root.children.length ? branch(root.children, 0) : '<li class="tree-empty">Belum ada folder</li>';
}
let treeTimer;
function refreshTreeSoon() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(() => {
    for (const id of new Set([S.rootId, ...T.open])) { const n = T.nodes.get(id); if (n && n.children) loadTreeChildren(id); }
  }, 500);
}
function moveFocus(e) {
  const els = $$('#items .it'); if (!els.length) return;
  e.preventDefault();
  const curEl = document.activeElement && document.activeElement.closest && document.activeElement.closest('#items .it');
  let i = curEl ? els.indexOf(curEl) : -1;
  let step = 1;
  if (S.view === 'grid') { const top = els[0].offsetTop; step = els.filter(x => x.offsetTop === top).length || 1; }
  const k = e.key;
  if (i < 0) i = 0;
  else if (k === 'ArrowRight') i = Math.min(els.length - 1, i + 1);
  else if (k === 'ArrowLeft') i = Math.max(0, i - 1);
  else if (k === 'ArrowDown') i = Math.min(els.length - 1, i + step);
  else if (k === 'ArrowUp') i = Math.max(0, i - step);
  else if (k === 'Home') i = 0;
  else if (k === 'End') i = els.length - 1;
  const el = els[i];
  el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' });
  if (e.shiftKey && S.anchor) selectRange(el.dataset.id); else selectOnly(el.dataset.id);
}
function treeForget(ids) {
  for (const n of T.nodes.values()) if (n.children) n.children = n.children.filter(c => !ids.has(c));
  renderTree();
}

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
    h += b('icon', 'i-palette', 'Ubah ikon');
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
    case 'icon': return openIconPicker(S.selected.has(f.id) && S.selected.size > 1 ? selectedItems() : [f]);
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
    if (S.route.type === 'folder' && S.route.id === parentId) { S.items.push(f); render(); selectOnly(f.id); }
    else refreshTreeSoon();
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
    if (isFolder(f)) { S.meta.set(f.id, { name: f.name, parents: f.parents }); const n = T.nodes.get(f.id); if (n) n.name = f.name; }
    render(); renderTree();
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
    refreshQuotaSoon(); refreshTreeSoon();
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
    refreshTreeSoon();
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
    refreshTreeSoon();
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
function doMove() { return moveItemsTo(MV.items, MV.at); }

/* ---------------------------------------------------------------- dialog ubah ikon */
const IC = { items: [], color: '', sym: '' };
function openIconPicker(list) {
  if (!list.length) return;
  IC.items = list;
  const p = iconPrefs(list[0]);
  IC.color = p.color; IC.sym = p.sym;
  $('#iconWhat').textContent = list.length === 1 ? '“' + list[0].name + '”' : list.length + ' item';
  $('#iconColors').innerHTML = `<button type="button" class="none" data-ic-color="" role="radio" title="Bawaan" aria-label="Warna bawaan"></button>` +
    Object.entries(ICON_COLORS).map(([k, c]) => `<button type="button" data-ic-color="${k}" role="radio" title="${c.label}" aria-label="${c.label}" style="--c:${c.front}"></button>`).join('');
  $('#iconGrid').innerHTML = `<button type="button" data-ic-sym="" role="radio"><svg viewBox="0 0 24 24"><path d="M5 5l14 14"/><circle cx="12" cy="12" r="9"/></svg>Tanpa</button>` +
    ICON_SYMBOLS.map(([k, label]) => `<button type="button" data-ic-sym="${k}" role="radio"><svg viewBox="0 0 24 24"><use href="#s-${k}"/></svg>${label}</button>`).join('');
  paintIconPicker();
  const d = $('#dlgIcon');
  d.returnValue = '';
  d.onclose = () => { if (d.returnValue === 'ok') saveIcons(IC.items, IC.color, IC.sym); };
  d.showModal();
}
function paintIconPicker() {
  for (const b of $$('#iconColors button')) b.setAttribute('aria-checked', String(b.dataset.icColor === IC.color));
  for (const b of $$('#iconGrid button')) b.setAttribute('aria-checked', String(b.dataset.icSym === IC.sym));
  const f = IC.items[0];
  const fake = Object.assign({}, f, { appProperties: { venaColor: IC.color, venaIcon: IC.sym } });
  $('#iconPreview').innerHTML = itemSvg(fake, '');
}
async function saveIcons(list, color, sym) {
  const props = { venaColor: color || null, venaIcon: sym || null };
  try {
    await runAll(list, f => api('/files/' + f.id, { method: 'PATCH', query: { fields: 'id,appProperties' }, body: { appProperties: props } }));
    for (const f of list) {
      const ap = Object.assign({}, f.appProperties);
      if (color) ap.venaColor = color; else delete ap.venaColor;
      if (sym) ap.venaIcon = sym; else delete ap.venaIcon;
      f.appProperties = ap;
      const n = T.nodes.get(f.id); if (n) n.appProperties = ap;
    }
    render(); renderTree();
    toast(list.length === 1 ? 'Ikon diubah.' : `Ikon ${list.length} item diubah.`);
  } catch (e) { fail(e, 'Gagal mengubah ikon'); }
}

/* ---------------------------------------------------------------- pindah (dipakai dialog & seret) */
async function moveItemsTo(list, target) {
  list = list.filter(f => f.id !== target && (f.parents || [])[0] !== target);
  if (!list.length) return;
  const ids = new Set(list.map(f => f.id));
  if (target !== S.rootId) {
    const chain = await folderChain(target);
    if (chain.some(c => ids.has(c.id))) { toast('Folder tidak bisa dipindahkan ke dalam dirinya sendiri.', { error: true }); return; }
  }
  try {
    await runAll(list, f => api('/files/' + f.id, { method: 'PATCH', query: {
      addParents: target, removeParents: (f.parents || []).join(','), fields: 'id,parents' } }));
    for (const f of list) { f.parents = [target]; if (isFolder(f)) S.meta.set(f.id, { name: f.name, parents: [target] }); }
    const name = target === S.rootId ? 'File saya' : (S.meta.get(target) || {}).name || 'folder';
    toast(list.length === 1 ? `“${list[0].name}” dipindahkan ke “${name}”.` : `${list.length} item dipindahkan ke “${name}”.`, {
      action: 'Buka', onAction: () => location.hash = folderHash(target) });
    if (S.route.type === 'folder' && S.route.id !== target) S.items = S.items.filter(f => !ids.has(f.id));
    S.selected.clear(); render(); refreshTreeSoon();
  } catch (e) { fail(e, 'Gagal memindahkan'); }
}

/* ---------------------------------------------------------------- seret-pindah di dalam aplikasi */
const DRAG = { ids: null };
function dropTargetOf(el) {
  if (!el || !el.closest) return null;
  const it = el.closest('#items .it');
  if (it) { const f = itemById(it.dataset.id); return f && isFolder(f) ? { el: it, id: f.id } : null; }
  const d = el.closest('[data-drop]');
  if (d) return { el: d, id: d.dataset.drop };
  const nav = el.closest('.nav a[data-nav="home"], .nav a[data-nav="trash"]');
  if (nav) return { el: nav, id: nav.dataset.nav === 'trash' ? '__trash' : S.rootId };
  return null;
}
function bindDrag() {
  let ghost = null, hover = null;
  const clearHover = () => { if (hover) hover.classList.remove('drop-hover'); hover = null; };
  document.addEventListener('dragstart', (e) => {
    const it = e.target.closest && e.target.closest('#items .it');
    if (!it || S.route.type === 'trash') { if (it) e.preventDefault(); return; }
    if (!S.selected.has(it.dataset.id)) selectOnly(it.dataset.id);
    DRAG.ids = [...S.selected];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-vena', DRAG.ids.join(','));
    e.dataTransfer.setData('text/plain', selectedItems().map(f => f.name).join('\n'));
    if (DRAG.ids.length > 1) {
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = `${DRAG.ids.length} item`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 16);
    }
    for (const id of DRAG.ids) { const el = $(`#items .it[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add('dragging'); }
  });
  document.addEventListener('dragend', () => {
    DRAG.ids = null; clearHover();
    if (ghost) { ghost.remove(); ghost = null; }
    for (const el of $$('#items .it.dragging')) el.classList.remove('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!DRAG.ids) return;
    const t = dropTargetOf(e.target);
    if (!t || DRAG.ids.includes(t.id)) { clearHover(); e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (hover !== t.el) { clearHover(); hover = t.el; hover.classList.add('drop-hover'); }
  });
  document.addEventListener('drop', (e) => {
    if (!DRAG.ids) return;
    const t = dropTargetOf(e.target);
    e.preventDefault();
    clearHover();
    const list = S.items.filter(f => DRAG.ids.includes(f.id));
    DRAG.ids = null;
    if (!t || !list.length) return;
    if (t.id === '__trash') trashItems(list);
    else moveItemsTo(list, t.id);
  });
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
  const pw = brokerMode();
  $('#pwForm').hidden = !pw;
  $('#btnLogin').hidden = pw;
  $('#loginLead').textContent = pw
    ? 'Masukkan password untuk membuka penyimpanan Anda.'
    : 'Unggah, atur, dan bagikan file. Semuanya tersimpan aman di Google Drive Anda sendiri.';
  $('#pwRemember').checked = LS.get('vena.remember') !== '0';
  const last = LS.get('vena.lastEmail');
  const allow = allowedEmail();
  const name = LS.get('vena.lastName');
  $('#btnLoginText').textContent = last ? `Lanjutkan sebagai ${name || last}` : 'Masuk dengan Google';
  $('#loginHint').textContent = pw ? '' : (allow ? `Gunakan akun ${allow}.` : (last || ''));
  $('#btnResetSetup').hidden = pw || !!CFG.CLIENT_ID;
}

async function boot() {
  applyTheme();
  for (const el of $$('[data-appname]')) el.textContent = CFG.APP_NAME;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  setupLoginScreen();
  if (brokerMode()) {
    loadSession();
    if (S.bsession) {
      try { await afterLogin(); return; }
      catch (e) { if (!e.auth) { console.warn(e); show('screenLogin'); $('#loginError').textContent = e.message; return; } }
    }
    clearSession();
    show('screenLogin');
    $('#pwInput').focus();
    return;
  }
  if (!clientId()) {
    $('#setupOrigin').textContent = location.origin.startsWith('http') ? location.origin : 'https://vena.web.id';
    $('#setupEmail').value = allowedEmail();
    show('screenSetup');
    return;
  }
  try { await waitForGis(); }
  catch (e) { show('screenLogin'); $('#loginError').textContent = e.message; return; }
  initTokenClient();
  loadSession();
  if (S.token) {
    try { await afterLogin(); return; }
    catch (e) { if (!e.auth) console.warn(e); clearSession(); }
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
  $('#pwForm').onsubmit = passwordLogin;
  $('#pwShow').onclick = () => {
    const i = $('#pwInput'); const on = i.type === 'password';
    i.type = on ? 'text' : 'password';
    $('#pwShow').textContent = on ? 'Sembunyikan' : 'Lihat';
  };
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
        case 'sel-download': downloadFiles(selectedItems()); return;
        case 'sel-open': { const f = selectedItems()[0]; if (f) openItem(f); return; }
        case 'sel-share': { const f = selectedItems()[0]; if (f) openShare(f); return; }
        case 'sel-rename': { const f = selectedItems()[0]; if (f) renameItem(f); return; }
        case 'sel-star': { const f = selectedItems()[0]; if (f) toggleStar(f); return; }
        case 'sel-icon': openIconPicker(selectedItems()); return;
        case 'icon-reset': IC.color = ''; IC.sym = ''; paintIconPicker(); return;
        case 'nav-back': navStep(-1); return;
        case 'nav-fwd': navStep(1); return;
        case 'nav-up': navUp(); return;
        case 'refresh': loadView(); refreshQuota(); return;
        case 'toggle-details': {
          const hidden = $('#win').classList.toggle('no-details');
          LS.set('vena.details', hidden ? '0' : '1');
          $('#btnDetails').setAttribute('aria-pressed', String(!hidden));
          renderDetails(); return;
        }
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

    // pohon folder: buka/tutup cabang
    const icc = t.closest('[data-ic-color]');
    if (icc) { IC.color = icc.dataset.icColor; paintIconPicker(); return; }
    const ics = t.closest('[data-ic-sym]');
    if (ics) { IC.sym = ics.dataset.icSym; if (!IC.color && IC.sym && !isFolder(IC.items[0])) IC.color = 'biru'; paintIconPicker(); return; }
    const tt = t.closest('[data-tree-toggle]');
    if (tt) { toggleTree(tt.dataset.treeToggle); return; }
    // judul kolom (tampilan detail) untuk mengurutkan
    const hs = t.closest('#listHead [data-sort]');
    if (hs) { S.sort = hs.dataset.sort; LS.set('vena.sort', S.sort); render(); return; }

    // item di jendela
    const item = t.closest('#items .it');
    if (item) {
      const id = item.dataset.id;
      if (lastPointer === 'touch') {
        // HP/tablet: ketuk = buka; kalau sedang memilih, ketuk = pilih
        if (S.selected.size) toggleSelect(id); else { const f = itemById(id); if (f) openItem(f); }
        return;
      }
      if (e.ctrlKey || e.metaKey) toggleSelect(id);
      else if (e.shiftKey && S.anchor) selectRange(id);
      else selectOnly(id);
      return;
    }
    // klik di area kosong jendela: batalkan pilihan
    if (t.closest('#content') && !t.closest('button, a')) clearSelection();

    // klik di luar menu menutupnya
    if (!t.closest('.menu')) closeMenus();
  });

  let lastPointer = 'mouse';
  document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);

  document.addEventListener('dblclick', (e) => {
    const item = e.target.closest('#items .it');
    if (!item || lastPointer === 'touch') return;
    const f = itemById(item.dataset.id); if (f) openItem(f);
  });

  document.addEventListener('contextmenu', (e) => {
    if ($('#screenApp').hidden) return;
    const item = e.target.closest('#items .it');
    if (item) {
      e.preventDefault();
      if (!S.selected.has(item.dataset.id) && lastPointer !== 'touch') selectOnly(item.dataset.id);
      openItemMenu(item.dataset.id, e.clientX, e.clientY, false);
      return;
    }
    if (e.target.closest('#content') && S.route.type !== 'trash') {
      e.preventDefault();
      clearSelection();
      closeMenus();
      placeMenu($('#menuNew'), e.clientX, e.clientY);
    }
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
      clearSelection();
      $('#screenApp').classList.remove('nav-open');
      return;
    }
    if (typing || $('#screenApp').hidden || document.querySelector('dialog[open]')) return;
    const sel = selectedItems();
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navStep(-1); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navStep(1); return; }
    if ((e.altKey && e.key === 'ArrowUp') || e.key === 'Backspace') { e.preventDefault(); navUp(); return; }
    if (e.key === 'F5') { e.preventDefault(); loadView(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
    if (e.key === 'F2' && sel.length === 1 && S.route.type !== 'trash') { e.preventDefault(); renameItem(sel[0]); return; }
    if (e.key === 'Enter' && sel.length === 1) { openItem(sel[0]); return; }
    if (e.key === 'Delete' && sel.length) {
      if (S.route.type === 'trash') deleteItems(sel); else trashItems(sel);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) { moveFocus(e); return; }
    if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
  });

  bindDrag();

  /* seret & lepas file dari komputer */
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
    const tile = e.target.closest && e.target.closest('#items .it');
    const tf = tile && itemById(tile.dataset.id);
    const base = tf && isFolder(tf) ? tf.id : curFolderId();
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
