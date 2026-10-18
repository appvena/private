/* =====================================================================
   VENA — aplikasi penyimpanan pribadi di atas Google Drive
   Tanpa server: browser langsung bicara ke Google Drive API memakai
   token OAuth dari Google Identity Services.
   ===================================================================== */
(() => {
'use strict';

/* ---------------------------------------------------------------- versi */
const APP_VERSION = '3.0.2';
const APP_BUILD = '18 Oktober 2026';

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
  token: null, exp: 0, bsession: null, user: null, drives: [], curDrive: null, parentMap: null, quota: null, rootId: null,
  route: { type: 'folder', id: null, q: '' },
  items: [], selected: new Set(),
  view: LS.get('vena.view') || 'grid',
  viewBy: (() => { try { return JSON.parse(LS.get('vena.viewBy') || '{}'); } catch { return {}; } })(),
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
  const plain = [...$('#toasts').children].filter(x => !x.classList.contains('toast-progress'));
  while (plain.length > 3) plain.shift().remove();
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
  for (const s of ['screenLoading', 'screenSetup', 'screenLogin', 'screenApp', 'screenDesktop', 'screenCmd']) $('#' + s).hidden = s !== id;
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
  installBackGuard();
  await ensureRoot();
  try { await loadDrives(); } catch (e) { S.drives = [{ id: S.rootId, root: true, letter: 'C', label: 'Data', color: '', limit: 0 }]; }
  enterSkin();
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
  try { stopPlayer(true); } catch {}
  try { leaveMulti(); } catch {}
  clearSession();
  S.user = null; S.rootId = null; S.drives = []; S.curDrive = null;
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
  if (method !== 'GET') notifySync();
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
    const all = [];
    do {
      const r = await api('/files', { query: { pageSize: 1000, pageToken, fields: 'nextPageToken,files(id,size,parents,mimeType,trashed)', spaces: 'drive' } });
      for (const f of r.files || []) {
        all.push(f);
        if (f.mimeType !== FOLDER) { total += Number(f.size) || 0; count++; }
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    S.appUsage = { total, count };
    // ukuran tiap folder = jumlah semua file di dalamnya (termasuk subfolder)
    const parentOfFolder = new Map();
    for (const f of all) if (f.mimeType === FOLDER && !f.trashed) parentOfFolder.set(f.id, (f.parents || [])[0]);
    const sizes = new Map();
    for (const f of all) {
      if (f.mimeType === FOLDER || f.trashed) continue;
      let p = (f.parents || [])[0], guard = 0;
      while (p && guard++ < 50) {
        const cur = sizes.get(p) || { bytes: 0, files: 0 };
        cur.bytes += Number(f.size) || 0; cur.files++;
        sizes.set(p, cur);
        if (isDriveRoot(p)) break;
        p = parentOfFolder.get(p);
      }
    }
    S.fsize = sizes;
    S.parentMap = parentOfFolder;
    renderQuota();
    paintFolderSizes();
  } catch {}
}
const folderSize = (id) => (S.fsize && S.fsize.get(id)) || { bytes: 0, files: 0 };
function paintFolderSizes() {
  for (const el of $$('#items .it')) {
    const f = itemById(el.dataset.id);
    if (f && isFolder(f) && S.fsize) el.querySelector('.c-size').textContent = fmtSize(folderSize(f.id).bytes);
  }
  renderDrives();
  if (S.route.type === 'drives') return;
  if (S.sort === 'size' && S.route.type !== 'recent') render(); else renderDetails();
}
let quotaTimer;
const refreshQuotaSoon = () => { clearTimeout(quotaTimer); quotaTimer = setTimeout(refreshQuota, 1500); };

/* ================================================================ RUTE */
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!h) return { type: 'drives' };
  if (h.startsWith('f/')) return { type: 'folder', id: h.slice(2) || S.rootId };
  if (h.startsWith('search/')) return { type: 'search', q: h.slice(7) };
  if (['recent', 'starred', 'shared', 'trash'].includes(h)) return { type: h };
  return { type: 'drives' };
}
const folderHash = (id) => '#/f/' + id;
const curFolderId = () => S.route.type === 'folder' ? S.route.id : curDrive();

function onRoute(silent = false) {
  if (!S.rootId) return;
  const prevKey = S.routeKey;
  S.route = parseHash();
  S.routeKey = location.hash || '#/';
  trackHistory(S.routeKey);
  if (prevKey !== S.routeKey) { S.selected.clear(); S.anchor = null; }
  S.view = S.viewBy[S.routeKey] || (EMBED === 'pane' ? 'list' : 'grid');            // tiap folder punya tampilan sendiri
  closeMenus();
  const navKey = S.route.type === 'drives' ? 'home' : S.route.type === 'folder' ? '' : S.route.type;
  if (S.route.type === 'folder') S.curDrive = isDriveRoot(S.route.id) ? S.route.id : driveOfFolder(S.route.id);
  for (const a of $$('.nav a, .bottom-nav a')) a.classList.toggle('active', a.dataset.nav === navKey);
  $('#searchInput').value = S.route.type === 'search' ? S.route.q : '';
  if ($('#screenApp').classList.contains('nav-open')) { $('#screenApp').classList.remove('nav-open'); forgetOverlay('nav'); }
  $('#trashNote').hidden = S.route.type !== 'trash';
  const trash = S.route.type === 'trash';
  for (const b of $$('#cmdbar [data-hide-in]')) b.hidden = trash;
  for (const b of $$('#cmdbar [data-show-in]')) b.hidden = !trash;
  $('#sortSelect').disabled = S.route.type === 'recent';
  updateClipUI();
  updateNavButtons();
  renderDrives();
  reportRoute();
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
  if (!id || isDriveRoot(id)) return null;
  const m = S.meta.get(id);
  return (m && m.parents && m.parents[0]) || curDrive();
}
function navUp() {
  if (S.route.type !== 'folder' || isDriveRoot(S.route.id)) { location.hash = '#/'; return; }
  const p = parentOf(S.route.id);
  if (p) location.hash = folderHash(p);
}
function updateNavButtons() {
  $('#navBack').disabled = H.idx <= 0;
  $('#navFwd').disabled = H.idx >= H.stack.length - 1;
  $('#navUp').disabled = S.route.type === 'drives';
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
    if (r.type === 'drives') {
      S.items = []; S.selected.clear();
      $('#listLoading').hidden = true;
      renderDrives(); renderDrivesOverview(); updatePlayAllButton(); renderSelection();
      return;
    }
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
      items = r.q ? await listAll(`(name contains '${qstr(r.q)}' or fullText contains '${qstr(r.q)}') and trashed=false`, { max: 500 }) : [];
    }
    if (seq !== S.loadSeq) return;
    items = items.filter(f => !isDriveRoot(f.id) && f.id !== S.rootId && !(f.appProperties && f.appProperties.venaTemp));
    S.items = items;
    for (const f of items) if (isFolder(f)) S.meta.set(f.id, { name: f.name, parents: f.parents });
    for (const id of [...S.selected]) if (!items.some(f => f.id === id)) S.selected.delete(id);
    render();
    expireOldLinks(items);
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
  while (cur && !isDriveRoot(cur) && guard++ < 25) {
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
  if (EMBED) toParent({ type: 'title', title: t, folder: S.route.type === 'folder' ? S.route.id : null, hash: location.hash || '#/' });
}
async function renderCrumbs() {
  const el = $('#crumbs');
  const r = S.route;
  const root = `<span class="root-ico">${icon('i-pc')}</span>`;
  const sep = `<span class="sep">${icon('i-chevron-right')}</span>`;
  const home = `<button data-go-home>Komputer ini</button>`;
  if (r.type === 'drives') { el.innerHTML = root + `<span class="current">Komputer ini</span>`; setTitle('Komputer ini'); return; }
  if (r.type === 'search') { el.innerHTML = root + home + sep + `<span class="current">Hasil pencarian “${esc(r.q)}”</span>`; setTitle('Cari: ' + r.q); return; }
  if (r.type !== 'folder') { el.innerHTML = root + home + sep + `<span class="current">${VIEW_TITLES[r.type]}</span>`; setTitle(VIEW_TITLES[r.type]); return; }
  const seq = S.loadSeq;
  const drv = driveById(curDrive());
  const dname = drv ? driveName(drv) : 'Drive';
  if (isDriveRoot(r.id)) { el.innerHTML = root + home + sep + `<span class="current">${esc(dname)}</span>`; setTitle(dname); renderDrives(); return; }
  el.innerHTML = root + home + sep + `<button data-go="${curDrive()}">${esc(dname)}</button>${sep}<span class="current">…</span>`;
  const chain = await folderChain(r.id);
  if (seq !== S.loadSeq) return;
  // drive yang sebenarnya = induk dari folder teratas di rantai
  const top = chain[0] && S.meta.get(chain[0].id);
  const realDrive = top && top.parents && isDriveRoot(top.parents[0]) ? top.parents[0] : curDrive();
  if (realDrive !== S.curDrive) { S.curDrive = realDrive; renderTree(); }
  const d2 = driveById(realDrive);
  let html = root + home + sep + `<button data-go="${realDrive}" data-drop="${realDrive}">${esc(d2 ? driveName(d2) : dname)}</button>`;
  chain.forEach((c, i) => {
    html += sep;
    html += i === chain.length - 1 ? `<span class="current" title="${esc(c.name)}">${esc(c.name)}</span>` : `<button data-go="${c.id}" data-drop="${c.id}" title="${esc(c.name)}">${esc(c.name)}</button>`;
  });
  el.innerHTML = html;
  el.scrollLeft = el.scrollWidth;
  setTitle(chain.length ? chain[chain.length - 1].name : dname);
  updateNavButtons();
  renderDrives();
  expandTreeTo(chain.map(c => c.id));
}

/* ================================================================ DRIVE (partisi seperti C: D: E:)
   Setiap drive = satu folder utama terpisah di Google Drive.
   C: = folder "Vena Drive" yang sudah ada. Drive lain ditandai appProperties
   venaDrive=1 beserta huruf, nama, warna, dan batas kapasitas (opsional). */
const isDriveRoot = (id) => S.drives.some(d => d.id === id);
const driveById = (id) => S.drives.find(d => d.id === id);
const driveName = (d) => `${d.label} (${d.letter}:)`;
const curDrive = () => S.curDrive && driveById(S.curDrive) ? S.curDrive : S.rootId;
function toDrive(f, isRoot) {
  const ap = f.appProperties || {};
  return { id: f.id, root: !!isRoot, letter: ap.venaLetter || (isRoot ? 'C' : '?'), label: ap.venaLabel || (isRoot ? 'Data' : f.name),
           color: ICON_COLORS[ap.venaDColor] ? ap.venaDColor : '', limit: Number(ap.venaLimit) || 0 };
}
async function loadDrives() {
  const [root, r] = await Promise.all([
    api('/files/' + S.rootId, { query: { fields: 'id,name,appProperties' } }),
    api('/files', { query: { q: "appProperties has { key='venaDrive' and value='1' } and trashed=false", fields: 'files(id,name,appProperties)', pageSize: 100, spaces: 'drive' } }),
  ]);
  S.drives = [toDrive(root, true), ...(r.files || []).map(f => toDrive(f))].sort((a, b) => a.letter.localeCompare(b.letter));
  for (const d of S.drives) S.meta.set(d.id, { name: driveName(d), parents: [] });
  renderDrives();
}
// cari drive tempat sebuah folder berada
function driveOfFolder(id) {
  let cur = id, guard = 0;
  while (cur && guard++ < 40) {
    if (isDriveRoot(cur)) return cur;
    const m = S.meta.get(cur);
    cur = (m && m.parents && m.parents[0]) || (S.parentMap && S.parentMap.get(cur));
  }
  return S.rootId;
}
const driveUsed = (d) => folderSize(d.id).bytes;
function driveColor(d) { return d.color ? ICON_COLORS[d.color] : null; }
function diskSvg(d, cls = '') {
  const c = driveColor(d);
  const body = c ? c.front : 'var(--accent-soft)', edge = c ? c.back : 'var(--accent)', ink = c ? c.ink : 'var(--accent)';
  return `<svg class="${cls}" viewBox="0 0 48 36" aria-hidden="true">
    <rect x="2" y="6" width="44" height="26" rx="6" fill="${body}" stroke="${edge}" stroke-width="2"/>
    <rect x="2" y="24" width="44" height="8" rx="3" fill="${edge}" opacity=".35"/>
    <circle cx="39" cy="28" r="1.8" fill="${ink}"/>
    <text x="17" y="22" text-anchor="middle" font-family="Bricolage Grotesque, system-ui, sans-serif" font-weight="700" font-size="15" fill="${ink}">${esc(d.letter)}</text></svg>`;
}
function usageText(d) {
  const used = driveUsed(d);
  return d.limit ? `${fmtSize(used)} dari ${fmtSize(d.limit)}` : `${fmtSize(used)} terpakai`;
}
function usagePct(d) { return d.limit ? Math.min(100, driveUsed(d) / d.limit * 100) : 0; }
function renderDrives() {
  if (EMBED === 'pane') {
    const cur = S.route.type === 'folder' ? curDrive() : null;
    $('#paneDrives').innerHTML = S.drives.map(d => `<button class="${cur === d.id ? 'on' : ''}" data-go="${d.id}" data-drop="${d.id}" title="${esc(driveName(d))}">${esc(d.letter)}:</button>`).join('');
  }
  if (!EMBED && typeof refreshDesktop === 'function') refreshDesktop();
  const el = $('#driveList'); if (!el) return;
  const cur = S.route.type === 'folder' ? curDrive() : null;
  el.innerHTML = S.drives.map(d => `<li>
    <button class="drv-row${cur === d.id ? ' active' : ''}" data-go="${d.id}" data-drop="${d.id}" data-drive="${d.id}" title="${esc(driveName(d))}">
      ${diskSvg(d, 'drv-ico')}
      <span class="drv-txt"><span class="drv-name">${esc(driveName(d))}</span>
        <span class="drv-bar${d.limit ? '' : ' nolimit'}"><span style="width:${usagePct(d)}%"></span></span>
        <span class="drv-use">${esc(usageText(d))}</span></span>
    </button></li>`).join('');
  $('#treeLabel').hidden = $('#tree').hidden = S.route.type === 'drives';
  $('#treeLabel').textContent = S.route.type === 'folder' ? 'Folder di ' + driveName(driveById(curDrive()) || S.drives[0] || { label: 'Data', letter: 'C' }) : 'Folder';
  if (S.route.type === 'drives') renderDrivesOverview();
}
function renderDrivesOverview() {
  const box = $('#items');
  box.className = 'items drives-grid';
  $('#content').classList.remove('listing');
  $('#emptyState').hidden = true;
  box.innerHTML = S.drives.map(d => {
    const pct = usagePct(d), warn = d.limit && pct > 90;
    return `<div class="drv-card" data-drive="${d.id}" data-drop="${d.id}" tabindex="0" role="button">
      ${diskSvg(d, 'drv-big')}
      <div class="drv-card-body">
        <strong>${esc(driveName(d))}</strong>
        <span class="drv-bar${d.limit ? '' : ' nolimit'}${warn ? ' warn' : ''}"><span style="width:${pct}%"></span></span>
        <span class="drv-use">${esc(usageText(d))}${d.limit ? `, sisa ${esc(fmtSize(Math.max(0, d.limit - driveUsed(d))))}` : ''}</span>
        <span class="drv-use">${folderSize(d.id).files.toLocaleString('id-ID')} file</span>
      </div>
      <button class="more-btn drv-more" data-drive-more="${d.id}" aria-label="Pilihan drive">${icon('i-more-h')}</button>
    </div>`;
  }).join('') + `<button class="drv-card drv-add" data-action="new-drive">${icon('i-plus')}<span>Tambah drive</span></button>`;
  renderStatus(); renderDetails();
}

/* ---- dialog buat / ubah drive ---- */
const DD = { edit: null, color: '' };
function openDriveDialog(d) {
  DD.edit = d || null;
  DD.color = d ? d.color : 'biru';
  const used = new Set(S.drives.filter(x => x !== d).map(x => x.letter));
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => !used.has(l));
  $('#driveLetter').innerHTML = letters.map(l => `<option value="${l}">${l}:</option>`).join('');
  $('#driveLetter').value = d ? d.letter : letters[0];
  $('#driveLabel').value = d ? d.label : '';
  $('#driveLimit').value = d && d.limit ? Math.round(d.limit / 1073741824) : '';
  $('#driveTitle').textContent = d ? 'Ubah drive ' + d.letter + ':' : 'Tambah drive';
  $('#driveOk').textContent = d ? 'Simpan' : 'Buat drive';
  $('#driveNote').hidden = !!d;
  $('#driveColors').innerHTML = `<button type="button" class="none" data-dcolor="" title="Bawaan" aria-label="Warna bawaan"></button>` +
    Object.entries(ICON_COLORS).map(([k, c]) => `<button type="button" data-dcolor="${k}" title="${c.label}" aria-label="${c.label}" style="--c:${c.front}"></button>`).join('');
  paintDriveDialog();
  const dlg = $('#dlgDrive');
  dlg.returnValue = '';
  dlg.onclose = () => { if (dlg.returnValue === 'ok') saveDrive(); };
  dlg.showModal();
  setTimeout(() => $('#driveLabel').focus(), 30);
}
function paintDriveDialog() {
  for (const b of $$('#driveColors button')) b.setAttribute('aria-checked', String(b.dataset.dcolor === DD.color));
  const fake = { letter: $('#driveLetter').value || 'D', label: $('#driveLabel').value.trim() || 'Drive baru', color: DD.color, limit: 0 };
  $('#drivePreview').innerHTML = diskSvg(fake, 'drv-big') + `<strong>${esc(driveName(fake))}</strong>`;
}
async function saveDrive() {
  const label = $('#driveLabel').value.trim();
  const letter = $('#driveLetter').value;
  const gb = Number($('#driveLimit').value) || 0;
  if (!label) { toast('Nama drive belum diisi.', { error: true }); return; }
  const props = { venaLetter: letter, venaLabel: label, venaDColor: DD.color || null, venaLimit: gb ? String(gb * 1073741824) : null };
  try {
    if (DD.edit) {
      const body = { appProperties: props };
      if (!DD.edit.root) body.name = `Vena ${letter} - ${label}`;
      await api('/files/' + DD.edit.id, { method: 'PATCH', query: { fields: 'id' }, body });
      toast(`Drive ${letter}: disimpan.`);
      await loadDrives(); renderCrumbs();
    } else {
      const f = await api('/files', { method: 'POST', query: { fields: 'id' }, body: {
        name: `Vena ${letter} - ${label}`, mimeType: FOLDER,
        appProperties: Object.assign({ venaDrive: '1' }, props),
        description: `Drive ${letter}: aplikasi ${CFG.APP_NAME}` } });
      await loadDrives();
      toast(`Drive ${label} (${letter}:) dibuat.`);
      if (isMultiSkin()) { refreshDesktop(); if (getSkin() === 'desktop') openWindow(folderHash(f.id), `${label} (${letter}:)`); }
      else location.hash = folderHash(f.id);
    }
    notifySync();
  } catch (e) { fail(e, 'Gagal menyimpan drive'); }
}
async function deleteDrive(d) {
  if (d.root) { toast('Drive C: adalah drive utama dan tidak bisa dihapus.', { error: true }); return; }
  const fs = folderSize(d.id);
  const ok = await confirmDialog(`Hapus drive ${driveName(d)}?`,
    (fs.files ? `Berisi ${fs.files.toLocaleString('id-ID')} file (${fmtSize(fs.bytes)}). ` : 'Drive ini kosong. ') +
    'Drive beserta isinya dipindahkan ke Sampah dan masih bisa dipulihkan selama 30 hari.', 'Hapus drive');
  if (!ok) return;
  try {
    await api('/files/' + d.id, { method: 'PATCH', query: { fields: 'id' }, body: { trashed: true } });
    S.drives = S.drives.filter(x => x.id !== d.id);
    toast(`Drive ${driveName(d)} dihapus.`);
    if (S.route.type === 'folder' && curDrive() === d.id) location.hash = '#/'; else renderDrives();
    refreshQuotaSoon();
  } catch (e) { fail(e, 'Gagal menghapus drive'); }
}
function openDriveMenu(id, x, y, alignRight) {
  const d = driveById(id); if (!d) return;
  closeMenus();
  const m = $('#menuItem');
  const b = (act, ic, label, cls = '') => `<button role="menuitem" data-drive-action="${act}" data-id="${d.id}" class="${cls}">${icon(ic)}${label}</button>`;
  m.innerHTML = b('open', 'i-folder', 'Buka') + b('edit', 'i-edit', 'Ubah nama, huruf, warna, kapasitas') +
    (d.root ? '' : '<hr>' + b('delete', 'i-trash', 'Hapus drive', 'danger'));
  placeMenu(m, x, y, alignRight);
}
function driveAction(act, id) {
  const d = driveById(id); if (!d) return;
  closeMenus();
  if (act === 'open') {
    if (!EMBED && getSkin() === 'desktop' && S.rootId) openWindow(folderHash(d.id), driveName(d));
    else if (!EMBED && getSkin() === 'commander') { const f = CM.frames[CM.active]; if (f) f.contentWindow.postMessage({ vena: true, type: 'go', hash: folderHash(d.id) }, location.origin); }
    else location.hash = folderHash(d.id);
  }
  else if (act === 'edit') openDriveDialog(d);
  else if (act === 'delete') deleteDrive(d);
}
// cek batas kapasitas sebelum menambah isi drive
async function fitsInDrive(targetFolder, bytes) {
  const d = driveById(driveOfFolder(targetFolder));
  if (!d || !d.limit || !bytes) return true;
  const free = d.limit - driveUsed(d);
  if (bytes <= free) return true;
  await confirmDialog(`Drive ${driveName(d)} tidak cukup`,
    `Butuh ${fmtSize(bytes)}, sisa ruang hanya ${fmtSize(Math.max(0, free))}. Hapus sebagian isi drive, pilih drive lain, atau naikkan batas kapasitasnya.`, 'Mengerti');
  return false;
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
  else if (S.sort === 'size') {
    const sz = (f) => isFolder(f) ? folderSize(f.id).bytes : (Number(f.size) || 0);
    a.sort((x, y) => sz(y) - sz(x) || byName(x, y));
  }
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
  updatePlayAllButton();
  renderSelection();
}

function itemHTML(f, trash) {
  const sel = S.selected.has(f.id);
  const k = kindOf(f);
  const thumb = !isFolder(f) && f.thumbnailLink && !(brokerMode() && S.directThumbBad)
    ? `<img data-thumb loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(f.thumbnailLink.replace(/=s\d+$/, '=s320'))}">` : '';
  return `<div class="it${sel ? ' selected' : ''}" data-id="${f.id}" tabindex="0" role="option" aria-selected="${sel}" title="${esc(f.name)}" style="--kind:var(--k-${isFolder(f) ? 'folder' : k})"${trash ? '' : ' draggable="true"'}>
    <div class="ic" data-kind="${k}">${thumb || itemSvg(f)}</div>
    <div class="nm"><span class="mini">${itemSvg(f, 'mini-svg')}</span><span class="label">${esc(f.name)}</span>${f.starred ? `<span class="star-badge" title="Berbintang">${icon('i-star')}</span>` : ''}</div>
    ${f.starred ? `<span class="star-badge grid-only" title="Berbintang">${icon('i-star')}</span>` : ''}
    ${f.shared ? `<span class="shared-badge" title="${shareUntil(f) ? 'Link berlaku sampai ' + esc(fmtUntil(shareUntil(f))) : 'Dibagikan dengan link'}">${icon('i-link')}</span>` : ''}
    <button class="more-btn" data-more aria-label="Pilihan untuk ${esc(f.name)}">${icon('i-more-h')}</button>
    <span class="col c-date">${trash ? '' : esc(fmtDate(f.modifiedTime))}</span>
    <span class="col c-type">${esc(isFolder(f) ? 'Folder' : KIND_LABEL[k])}</span>
    <span class="col c-size">${isFolder(f) ? (S.fsize ? esc(fmtSize(folderSize(f.id).bytes)) : '') : esc(fmtSize(f.size))}</span>
  </div>`;
}

/* thumbnail lewat server Vena (untuk perangkat yang tidak login Google) */
const TH = { queue: new Map(), timer: null, busy: false, mem: new Map() };
const thumbKey = (f) => `https://vena.local/thumb/${f.id}/${encodeURIComponent(f.modifiedTime || '')}`;
async function cachedThumb(f) {
  if (TH.mem.has(f.id)) return TH.mem.get(f.id);
  try {
    const c = await caches.open('vena-thumbs');
    const r = await c.match(thumbKey(f));
    if (r) { const u = await r.text(); TH.mem.set(f.id, u); return u; }
  } catch {}
  return null;
}
async function storeThumb(f, dataUrl) {
  TH.mem.set(f.id, dataUrl);
  try { const c = await caches.open('vena-thumbs'); await c.put(thumbKey(f), new Response(dataUrl)); } catch {}
}
function paintThumb(id, url) {
  for (const box of $$(`#items .it[data-id="${CSS.escape(id)}"] .ic`)) {
    box.innerHTML = `<img alt="" src="${url}">`;
  }
}
async function queueServerThumb(f) {
  const hit = await cachedThumb(f);
  if (hit) { paintThumb(f.id, hit); return; }
  TH.queue.set(f.id, f);
  clearTimeout(TH.timer);
  TH.timer = setTimeout(flushThumbs, 120);
}
async function flushThumbs() {
  if (TH.busy || !TH.queue.size || !brokerMode() || !S.bsession) return;
  TH.busy = true;
  const batch = [...TH.queue.values()].slice(0, 20);
  for (const f of batch) TH.queue.delete(f.id);
  try {
    const r = await server('thumbs', { session: S.bsession.id, ids: batch.map(f => f.id), size: 320 });
    for (const f of batch) {
      const u = r.thumbs && r.thumbs[f.id];
      if (u) { await storeThumb(f, u); paintThumb(f.id, u); }
    }
  } catch {}
  TH.busy = false;
  if (TH.queue.size) flushThumbs();
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
      S.directThumbBad = true;
      if (box.dataset.kind === 'image' && Number(f.size) < 6e6) {
        if (thumbObserver) thumbObserver.observe(box); else loadBlobThumb(box);
      } else if (brokerMode()) queueServerThumb(f);
    };
  }
  if (brokerMode() && S.directThumbBad) {
    for (const box of $$('#items .ic')) {
      if (box.querySelector('img')) continue;
      const f = itemById(box.closest('.it').dataset.id);
      if (f && f.thumbnailLink && !(box.dataset.kind === 'image' && Number(f.size) < 6e6)) queueServerThumb(f);
    }
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
    folder: isDriveRoot(S.route.id)
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
function selectOnly(id) {
  S.selected = new Set([id]); S.anchor = id; paintSelection();
  const f = itemById(id); if (f && matchMedia('(hover: hover)').matches) prepareDragOut(f);
}
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
  if (S.route.type === 'drives') { $('#statusCount').textContent = `${S.drives.length} drive`; $('#statusSel').textContent = ''; return; }
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
      : !folder && TH.mem.has(f.id) ? `<img alt="" src="${TH.mem.get(f.id)}">`
      : !folder && f.thumbnailLink ? `<img alt="" referrerpolicy="no-referrer" src="${esc(f.thumbnailLink.replace(/=s\d+$/, '=s600'))}" onerror="this.replaceWith(document.createRange().createContextualFragment(this.dataset.fb))" data-fb="${esc(itemSvg(f))}">`
      : itemSvg(f);
    let acts = '';
    if (trash) acts = btn('sel-restore', 'i-restore', 'Pulihkan', 'btn-primary') + btn('sel-delete', 'i-trash', 'Hapus permanen', 'danger');
    else acts = btn('sel-open', folder ? 'i-folder' : 'i-eye', folder ? 'Buka folder' : 'Buka', 'btn-primary')
      + btn('sel-download', 'i-download', folder ? 'Unduh ZIP' : 'Unduh')
      + btn('sel-share', 'i-link', f.shared ? 'Link aktif' : 'Bagikan')
      + btn('sel-rename', 'i-edit', 'Ganti nama')
      + btn('sel-move', 'i-move', 'Pindahkan')
      + btn('sel-copy', 'i-copy', 'Salin ke…')
      + btn('sel-star', 'i-star', f.starred ? 'Lepas bintang' : 'Bintangi')
      + btn('sel-icon', 'i-palette', 'Ubah ikon')
      + btn('sel-trash', 'i-trash', 'Hapus', 'danger');
    el.innerHTML = `<div class="d-preview">${prev}</div>
      <h3>${esc(f.name)}</h3>
      <dl>
        <dt>Jenis</dt><dd>${esc(typeLabel(f))}</dd>
        ${folder ? (S.fsize ? `<dt>Ukuran</dt><dd>${esc(fmtSize(folderSize(f.id).bytes))} (${folderSize(f.id).files.toLocaleString('id-ID')} file)</dd>` : '') : `<dt>Ukuran</dt><dd>${esc(fmtSize(f.size))}</dd>`}
        <dt>Diubah</dt><dd>${esc(fmtLong(f.modifiedTime))}</dd>
        <dt>Dibuat</dt><dd>${esc(fmtLong(f.createdTime))}</dd>
        <dt>Berbagi</dt><dd>${f.shared ? (shareUntil(f) ? 'Link aktif sampai ' + esc(fmtUntil(shareUntil(f))) : 'Siapa saja yang punya link') : 'Hanya Anda'}</dd>
      </dl>
      <div class="d-actions">${acts}</div>`;
    return;
  }
  if (sel.length > 1) {
    const size = sel.reduce((s, f) => s + (isFolder(f) ? folderSize(f.id).bytes : (Number(f.size) || 0)), 0);
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
  if (S.route.type === 'drives') {
    const tot = S.drives.reduce((n, d) => n + driveUsed(d), 0);
    el.innerHTML = `<div class="d-preview">${icon('i-pc', 'i i-xl')}</div><h3>Komputer ini</h3>
      <dl>${S.drives.map(d => `<dt>${esc(d.letter)}:</dt><dd>${esc(d.label)}, ${esc(usageText(d))}</dd>`).join('')}
      <dt>Total</dt><dd>${esc(fmtSize(tot))}</dd></dl>
      <p class="d-hint">Klik drive untuk membukanya. Klik kanan drive untuk mengubah nama, huruf, warna, atau batas kapasitas. Seret file ke drive di panel kiri untuk memindahkannya.</p>
      <div class="d-actions"><button class="btn btn-primary" data-action="new-drive">${icon('i-plus')}Tambah drive</button></div>`;
    return;
  }
  const title = S.route.type === 'folder' ? ($('#winTitle').textContent || 'File saya') : (VIEW_TITLES[S.route.type] || 'Hasil pencarian');
  const files = S.items.filter(f => !isFolder(f));
  const size = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  el.innerHTML = `<div class="d-preview">${folderSvg()}</div>
    <h3>${esc(title)}</h3>
    <dl>
      <dt>Isi</dt><dd>${S.items.length - files.length} folder, ${files.length} file</dd>
      <dt>Ukuran</dt><dd>${esc(fmtSize(S.route.type === 'folder' && S.fsize ? folderSize(S.route.id).bytes : size))}${S.route.type === 'folder' && S.fsize ? ' (termasuk subfolder)' : ''}</dd>
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
  const rid = curDrive();
  const root = T.nodes.get(rid);
  T.loading = T.loading || new Set();
  if (!root || !root.children) { el.innerHTML = '<li class="tree-empty">Memuat…</li>'; if (!T.loading.has(rid)) { T.loading.add(rid); loadTreeChildren(rid); } return; }
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
    for (const id of new Set([curDrive(), ...S.drives.map(d => d.id), ...T.open])) { const n = T.nodes.get(id); if (n && n.children) loadTreeChildren(id); }
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
    h += folder ? b('open', 'i-folder', 'Buka') : b('open', mediaKind(f) ? 'i-play' : 'i-eye', mediaKind(f) ? 'Putar' : 'Pratinjau');
    if (folder) h += b('playfolder', 'i-play', 'Putar musik / video di folder ini');
    if (folder && EMBED === 'window') h += b('newwin', 'i-external', 'Buka di jendela baru');
    h += b('download', 'i-download', folder ? 'Unduh sebagai ZIP' : 'Unduh');
    h += b('share', 'i-link', f.shared ? 'Kelola link berbagi' : 'Bagikan link');
    h += b('sendwa', 'i-chat', 'Kirim lewat WhatsApp');
    h += '<hr>';
    h += b('rename', 'i-edit', 'Ganti nama');
    h += b('move', 'i-move', 'Pindahkan ke…');
    h += b('copyto', 'i-copy', 'Salin ke…');
    h += b('duplicate', 'i-copy', 'Buat salinan di sini');
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
    case 'sendwa': return quickSendWa(f);
    case 'playfolder': return playFolder(f);
    case 'newwin': return toParent({ type: 'open', hash: folderHash(f.id), title: f.name });
    case 'copyto': return openMove(S.selected.has(f.id) && S.selected.size > 1 ? selectedItems() : [f], 'copy');
    case 'duplicate': return copyItems(S.selected.has(f.id) && S.selected.size > 1 ? selectedItems() : [f], (f.parents || [])[0] || curDrive());
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
  const mk = mediaKind(f);
  if (mk) { playList(visibleFiles(), f.id, mk); return; }
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
  const nF = list.filter(isFolder).length;
  const ok = await confirmDialog(
    list.length === 1 ? `Hapus “${list[0].name}”?` : `Hapus ${list.length} item?`,
    (nF ? 'Folder ikut dihapus beserta isinya. ' : '') + 'Item dipindahkan ke Sampah dan masih bisa dipulihkan selama 30 hari.', 'Hapus');
  if (!ok) return;
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

/* ---------------------------------------------------------------- unduh
   - File besar di komputer (Chrome/Edge): langsung ditulis ke disk sambil
     diunduh, tidak ditampung di memori.
   - Folder atau banyak file: dibungkus jadi satu ZIP.
   - Selalu ada progres dan tombol Batal. */
async function fetchBlob(f, signal) {
  const res = await api('/files/' + f.id, { query: { alt: 'media', acknowledgeAbuse: 'false' }, raw: true, signal });
  return res.blob();
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const isGoogleDoc = (f) => (f.mimeType || '').startsWith('application/vnd.google-apps.');
const canStreamToDisk = () => typeof window.showSaveFilePicker === 'function';

function progressToast(title) {
  const el = document.createElement('div');
  el.className = 'toast toast-progress';
  el.innerHTML = `<div class="tp-body"><span class="tp-title"></span><span class="tp-sub"></span><span class="tp-bar"><span></span></span></div><button type="button">Batal</button>`;
  el.querySelector('.tp-title').textContent = title;
  const ctl = new AbortController();
  el.querySelector('button').onclick = () => { ctl.abort(); el.remove(); };
  $('#toasts').appendChild(el);
  return {
    signal: ctl.signal,
    set(sub, frac) {
      el.querySelector('.tp-sub').textContent = sub;
      el.querySelector('.tp-bar span').style.width = (frac == null ? 0 : Math.min(100, frac * 100)) + '%';
      el.classList.toggle('indeterminate', frac == null);
    },
    close() { el.remove(); },
  };
}

// minta lokasi simpan (harus dipanggil langsung dari klik pengguna)
async function pickSaveTarget(name, mime) {
  if (!canStreamToDisk()) return null;
  try {
    const opts = { suggestedName: name };
    const h = await window.showSaveFilePicker(opts);
    return await h.createWritable();
  } catch (e) {
    if (e.name === 'AbortError') throw e;      // pengguna membatalkan
    return null;                                 // tidak didukung → pakai cara biasa
  }
}

// alirkan isi file Drive ke "sink" sambil melapor progres
async function pumpFile(f, signal, onChunk, onBytes) {
  const res = await api('/files/' + f.id, { query: { alt: 'media', acknowledgeAbuse: 'false' }, raw: true, signal });
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await onChunk(value);
    onBytes(value.byteLength);
  }
}

async function downloadFiles(list) {
  if (!list.length) return;
  const hasFolder = list.some(isFolder);
  const files = list.filter(f => !isFolder(f));
  if (hasFolder || files.length > 3) return downloadZip(list);
  for (const f of files) {
    if (isGoogleDoc(f)) { window.open(f.webViewLink, '_blank', 'noopener'); continue; }
    await downloadOne(f, files.length === 1);
  }
}

async function downloadOne(f, mayPick) {
  const size = Number(f.size) || 0;
  let writable = null;
  if (mayPick && size > 50e6) {
    try { writable = await pickSaveTarget(f.name); } catch { return; }
  }
  if (!writable && size > 700e6 && !canStreamToDisk()) {
    toast('File ini besar. Di HP, unduhan bisa lambat atau gagal kalau memori tidak cukup; sebaiknya unduh lewat komputer.', { ms: 7000 });
  }
  const p = progressToast('Mengunduh ' + f.name);
  const parts = [];
  let got = 0;
  try {
    await pumpFile(f, p.signal,
      async (chunk) => { if (writable) await writable.write(chunk); else parts.push(chunk); },
      (n) => { got += n; p.set(`${fmtSize(got)} dari ${fmtSize(size)}`, size ? got / size : null); });
    if (writable) await writable.close();
    else saveBlob(new Blob(parts, { type: f.mimeType || 'application/octet-stream' }), f.name);
    p.close();
    toast(`“${f.name}” selesai diunduh.`);
  } catch (e) {
    p.close();
    if (writable) { try { await writable.abort(); } catch {} }
    if (e.name === 'AbortError') toast('Unduhan dibatalkan.');
    else fail(e, 'Gagal mengunduh ' + f.name);
  }
}

/* ---- ZIP ---- */
let fflateReady = null;
function loadFflate() {
  if (window.fflate) return Promise.resolve();
  if (!fflateReady) fflateReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
    s.onload = () => resolve();
    s.onerror = () => { fflateReady = null; reject(new Error('Komponen ZIP gagal dimuat. Periksa koneksi internet.')); };
    document.head.appendChild(s);
  });
  return fflateReady;
}

// kumpulkan semua file di dalam folder (rekursif) beserta jalurnya
async function collectForZip(list, signal) {
  const out = [], used = new Set();
  const uniq = (path) => {
    let p = path, i = 2;
    const dot = path.lastIndexOf('.');
    while (used.has(p.toLowerCase())) { p = dot > path.lastIndexOf('/') ? `${path.slice(0, dot)} (${i})${path.slice(dot)}` : `${path} (${i})`; i++; }
    used.add(p.toLowerCase()); return p;
  };
  const clean = (n) => n.replace(/[\\/:*?"<>|]/g, '_');
  async function walk(folder, prefix) {
    if (signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
    const kids = await listAll(`'${qstr(folder.id)}' in parents and trashed=false`, { max: 100000 });
    if (!kids.length) out.push({ dir: uniq(prefix + clean(folder.name) + '/') });
    for (const k of kids) {
      if (isFolder(k)) await walk(k, prefix + clean(folder.name) + '/');
      else if (!isGoogleDoc(k)) out.push({ f: k, path: uniq(prefix + clean(folder.name) + '/' + clean(k.name)) });
    }
  }
  for (const it of list) {
    if (isFolder(it)) await walk(it, '');
    else if (!isGoogleDoc(it)) out.push({ f: it, path: uniq(clean(it.name)) });
  }
  return out;
}

async function downloadZip(list) {
  const zipName = (list.length === 1 && isFolder(list[0]) ? list[0].name : 'Vena-unduhan') + '.zip';
  // tanya lokasi simpan dulu (masih di dalam klik pengguna)
  let writable = null;
  try { writable = await pickSaveTarget(zipName); } catch { return; }
  const p = progressToast('Menyiapkan ' + zipName);
  p.set('Mendata isi folder…', null);
  try {
    await loadFflate();
    const entries = await collectForZip(list, p.signal);
    const files = entries.filter(e => e.f);
    const total = files.reduce((s, e) => s + (Number(e.f.size) || 0), 0);
    if (!files.length && !entries.length) { p.close(); toast('Tidak ada file untuk diunduh.'); return; }
    if (!writable && total > 1.5e9) {
      p.close();
      const ok = await confirmDialog('ZIP sangat besar',
        `Total ${fmtSize(total)}. Browser ini harus menampung semuanya di memori dulu, jadi bisa gagal. Sebaiknya pakai Chrome/Edge di komputer, atau unduh per folder kecil. Tetap lanjutkan?`, 'Lanjutkan');
      if (!ok) { if (writable) await writable.abort(); return; }
      return downloadZipRun(entries, files, total, zipName, null);
    }
    p.close();
    return downloadZipRun(entries, files, total, zipName, writable);
  } catch (e) {
    p.close();
    if (writable) { try { await writable.abort(); } catch {} }
    if (e.name === 'AbortError') toast('Unduhan dibatalkan.'); else fail(e, 'Gagal membuat ZIP');
  }
}

async function downloadZipRun(entries, files, total, zipName, writable) {
  const p = progressToast('Mengunduh ' + zipName);
  const parts = [];
  let chain = Promise.resolve(), werr = null, got = 0;
  const zip = new fflate.Zip((err, chunk, final) => {
    if (err) { werr = err; return; }
    if (writable) chain = chain.then(() => writable.write(chunk)).catch(e => { werr = e; });
    else parts.push(chunk);
  });
  try {
    let i = 0;
    for (const e of entries) {
      if (p.signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
      if (e.dir) { const d = new fflate.ZipPassThrough(e.dir); zip.add(d); d.push(new Uint8Array(0), true); continue; }
      i++;
      const entry = new fflate.ZipPassThrough(e.path);
      entry.mtime = e.f.modifiedTime ? new Date(e.f.modifiedTime) : new Date();
      zip.add(entry);
      await pumpFile(e.f, p.signal, async (chunk) => {
        entry.push(chunk, false);
        if (writable) await chain;             // tahan laju supaya memori tidak menumpuk
        if (werr) throw werr;
      }, (n) => { got += n; p.set(`File ${i} dari ${files.length}, ${fmtSize(got)} dari ${fmtSize(total)}`, total ? got / total : null); });
      entry.push(new Uint8Array(0), true);
    }
    zip.end();
    await chain;
    if (werr) throw werr;
    if (writable) await writable.close();
    else saveBlob(new Blob(parts, { type: 'application/zip' }), zipName);
    p.close();
    toast(`${zipName} selesai diunduh (${files.length} file).`);
  } catch (e) {
    p.close();
    try { zip.terminate(); } catch {}
    if (writable) { try { await writable.abort(); } catch {} }
    if (e.name === 'AbortError') toast('Unduhan dibatalkan.'); else fail(e, 'Gagal membuat ZIP');
  }
}

/* ---------------------------------------------------------------- bagikan (dengan batas waktu) */
let shareItem = null;
const shareUntil = (f) => (f.appProperties && f.appProperties.venaShareUntil) || '';
function fmtUntil(iso) {
  return new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function openShare(f) {
  shareItem = f;
  $('#shareName').textContent = f.name;
  $('#shareToggle').checked = !!f.shared;
  $('#shareToggle').disabled = true;
  $('#shareLink').value = f.webViewLink || '';
  fillExpirySelect(f);
  updateShareUI(!!f.shared);
  $('#dlgShare').showModal();
  try {
    const r = await api('/files/' + f.id, { query: { fields: 'id,webViewLink,appProperties,permissions(id,type,role)' } });
    const anyone = (r.permissions || []).some(p => p.type === 'anyone');
    f.webViewLink = r.webViewLink; f.shared = anyone; f.appProperties = r.appProperties || f.appProperties;
    $('#shareToggle').checked = anyone;
    $('#shareLink').value = r.webViewLink || '';
    fillExpirySelect(f);
    updateShareUI(anyone);
  } catch (e) { fail(e); }
  $('#shareToggle').disabled = false;
}
function fillExpirySelect(f) {
  const u = shareUntil(f);
  const sel = $('#shareExpiry');
  sel.innerHTML = (u ? `<option value="keep">Sampai ${esc(fmtUntil(u))}</option>` : '') +
    '<option value="0">Selamanya</option><option value="1">1 hari</option><option value="7">7 hari</option><option value="30">30 hari</option>';
  sel.value = u ? 'keep' : '0';
}
function updateShareUI(on) {
  const u = shareItem && shareUntil(shareItem);
  $('#shareState').textContent = on
    ? (u ? `Siapa pun yang punya link bisa melihat, sampai ${fmtUntil(u)}` : 'Siapa pun yang punya link bisa melihat')
    : 'Hanya Anda yang bisa membuka';
  $('#shareLinkRow').hidden = !on;
  $('#shareApps').hidden = !on;
  $('#shareNative').hidden = !navigator.share;
  $('#shareExpiryRow').hidden = !on;
}
function expiryFromSelect() {
  const v = $('#shareExpiry').value;
  if (v === 'keep') return undefined;           // tidak diubah
  if (v === '0') return null;
  return new Date(Date.now() + Number(v) * 86400000).toISOString();
}
async function saveExpiry(f, until) {
  const props = until ? { venaShare: '1', venaShareUntil: until } : { venaShare: null, venaShareUntil: null };
  await api('/files/' + f.id, { method: 'PATCH', query: { fields: 'id' }, body: { appProperties: props } });
  const ap = Object.assign({}, f.appProperties);
  if (until) { ap.venaShare = '1'; ap.venaShareUntil = until; } else { delete ap.venaShare; delete ap.venaShareUntil; }
  f.appProperties = ap;
}
async function setShared(on) {
  const f = shareItem; if (!f) return;
  $('#shareToggle').disabled = true;
  try {
    if (on) {
      await api(`/files/${f.id}/permissions`, { method: 'POST', query: { fields: 'id' }, body: { type: 'anyone', role: 'reader' } });
      const until = expiryFromSelect();
      if (until !== undefined) await saveExpiry(f, until);
    } else {
      await api(`/files/${f.id}/permissions/anyoneWithLink`, { method: 'DELETE' });
      if (shareUntil(f)) await saveExpiry(f, null);
    }
    f.shared = on;
    fillExpirySelect(f);
    updateShareUI(on);
    if (on) copyLink(); else toast('Link berbagi dimatikan.');
    if (S.route.type === 'shared' && !on) S.items = S.items.filter(x => x.id !== f.id);
    render();
  } catch (e) {
    $('#shareToggle').checked = !on;
    fail(e, 'Gagal mengubah akses');
  }
  $('#shareToggle').disabled = false;
}
async function changeExpiry() {
  const f = shareItem; if (!f || !f.shared) return;
  const until = expiryFromSelect();
  if (until === undefined) return;
  try {
    await saveExpiry(f, until);
    fillExpirySelect(f); updateShareUI(true); render();
    toast(until ? `Link berlaku sampai ${fmtUntil(until)}.` : 'Link berlaku selamanya.');
  } catch (e) { fail(e, 'Gagal mengubah batas waktu'); }
}
// matikan link yang sudah lewat waktunya (cadangan dari jadwal di server)
async function expireOldLinks(list) {
  const now = new Date().toISOString();
  const old = list.filter(f => f.shared && shareUntil(f) && shareUntil(f) < now);
  for (const f of old) {
    try {
      await api(`/files/${f.id}/permissions/anyoneWithLink`, { method: 'DELETE' });
      await saveExpiry(f, null);
      f.shared = false;
    } catch {}
  }
  if (old.length) render();
}
/* ---- kirim link lewat WhatsApp / Telegram / Email / aplikasi lain ---- */
function shareMessage(f, link) {
  const u = shareUntil(f);
  return `${f.name}\n${link}` + (u ? `\n(Link berlaku sampai ${fmtUntil(u)})` : '');
}
function sendVia(app, f, link, win) {
  const text = shareMessage(f, link);
  const urls = {
    wa: 'https://wa.me/?text=' + encodeURIComponent(text),
    tg: 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(f.name),
    mail: 'mailto:?subject=' + encodeURIComponent(f.name) + '&body=' + encodeURIComponent(text),
  };
  if (app === 'mail') { if (win) win.close(); location.href = urls.mail; return; }
  if (win) win.location.href = urls[app]; else window.open(urls[app], '_blank', 'noopener');
}
async function sendNative(f, link) {
  try { await navigator.share({ title: f.name, text: shareMessage(f, ''), url: link }); }
  catch (e) { if (e.name !== 'AbortError') copyLink(); }
}
// dari menu: aktifkan link (kalau belum) lalu langsung buka WhatsApp
async function quickSendWa(f) {
  let win = null;
  if (!f.shared) {
    const ok = await confirmDialog('Aktifkan link berbagi?', `Siapa pun yang menerima link bisa melihat “${f.name}”. Anda bisa mematikannya kapan saja.`, 'Aktifkan & kirim');
    if (!ok) return;
    win = window.open('', '_blank');            // dibuka sekarang supaya tidak diblokir browser
  }
  try {
    if (!f.shared) {
      await api(`/files/${f.id}/permissions`, { method: 'POST', query: { fields: 'id' }, body: { type: 'anyone', role: 'reader' } });
      f.shared = true; render();
    }
    if (!f.webViewLink) { const r = await api('/files/' + f.id, { query: { fields: 'webViewLink' } }); f.webViewLink = r.webViewLink; }
    sendVia('wa', f, f.webViewLink, win);
  } catch (e) { if (win) win.close(); fail(e, 'Gagal membagikan'); }
}

async function copyLink() {
  const v = $('#shareLink').value;
  try { await navigator.clipboard.writeText(v); toast('Link disalin.'); }
  catch { $('#shareLink').select(); toast('Tekan Ctrl+C untuk menyalin link.'); }
}

/* ---------------------------------------------------------------- salin */
async function copyItems(list, target) {
  if (!list.length) return;
  if (!(await fitsInDrive(target, list.reduce((n, f) => n + (isFolder(f) ? folderSize(f.id).bytes : Number(f.size) || 0), 0)))) return;
  if (!isDriveRoot(target)) {
    const chain = await folderChain(target);
    const ids = new Set(list.filter(isFolder).map(f => f.id));
    if (ids.has(target) || chain.some(c => ids.has(c.id))) { toast('Folder tidak bisa disalin ke dalam dirinya sendiri.', { error: true }); return; }
  }
  const p = progressToast(list.length === 1 ? `Menyalin “${list[0].name}”` : `Menyalin ${list.length} item`);
  let done = 0;
  p.set('Memulai…', null);
  const copyFile = async (f, parent, name) => {
    if (p.signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
    const r = await api(`/files/${f.id}/copy`, { method: 'POST', query: { fields: FIELDS }, body: { name, parents: [parent] } });
    done++; p.set(`${done} file disalin`, null);
    return r;
  };
  const copyFolder = async (f, parent, name) => {
    if (p.signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
    const nf = await api('/files', { method: 'POST', query: { fields: FIELDS }, body: { name, mimeType: FOLDER, parents: [parent], appProperties: f.appProperties || undefined } });
    const kids = await listAll(`'${qstr(f.id)}' in parents and trashed=false`, { max: 100000 });
    for (const k of kids) {
      if (isFolder(k)) await copyFolder(k, nf.id, k.name);
      else if (!isGoogleDoc(k)) await copyFile(k, nf.id, k.name);
    }
    return nf;
  };
  try {
    for (const f of list) {
      const sameParent = (f.parents || [])[0] === target;
      const name = sameParent ? `Salinan dari ${f.name}` : f.name;
      if (isFolder(f)) await copyFolder(f, target, name); else await copyFile(f, target, name);
    }
    p.close();
    const tname = (S.meta.get(target) || {}).name || 'folder';
    toast(list.length === 1 ? `“${list[0].name}” disalin ke “${tname}”.` : `${list.length} item disalin ke “${tname}”.`,
      S.route.type === 'folder' && S.route.id === target ? {} : { action: 'Buka', onAction: () => location.hash = folderHash(target) });
    if (S.route.type === 'folder' && S.route.id === target) loadView(true);
    refreshTreeSoon(); refreshQuotaSoon();
  } catch (e) {
    p.close();
    if (e.name === 'AbortError') toast('Penyalinan dihentikan.'); else fail(e, 'Gagal menyalin');
    if (S.route.type === 'folder' && S.route.id === target) loadView(true);
  }
}
// papan klip internal: Ctrl+C / Ctrl+X lalu Ctrl+V
function setClip(mode) {
  const list = selectedItems();
  if (!list.length || S.route.type === 'trash') return;
  S.clip = { mode, items: list };
  updateClipUI();
  toast(`${list.length === 1 ? '“' + list[0].name + '”' : list.length + ' item'} ${mode === 'cut' ? 'siap dipindahkan' : 'disalin'}. Buka folder tujuan, lalu klik Tempel atau tekan Ctrl+V.`, { ms: 5000 });
}
function updateClipUI() {
  const on = !!S.clip && S.route.type === 'folder';
  $('#cmdPaste').hidden = !on;
  $('#menuPaste').hidden = !on;
}
async function pasteClip() {
  if (!S.clip) return;
  if (S.route.type !== 'folder') { toast('Buka folder tujuan dulu, lalu tempel.'); return; }
  const { mode, items } = S.clip;
  const target = S.route.id;
  if (mode === 'cut') { S.clip = null; updateClipUI(); await moveItemsTo(items, target); loadView(true); }
  else await copyItems(items, target);
}

/* ---------------------------------------------------------------- pindahkan */
const MV = { items: [], at: null };
async function openMove(list, mode = 'move') {
  if (!list.length) return;
  MV.items = list; MV.mode = mode;
  $('#moveVerb').textContent = mode === 'copy' ? 'Salin' : 'Pindahkan';
  $('#moveOk').textContent = mode === 'copy' ? 'Salin ke sini' : 'Pindahkan ke sini';
  MV.at = S.route.type === 'folder' ? S.route.id : null;
  $('#moveWhat').textContent = list.length === 1 ? `“${list[0].name}”` : `${list.length} item`;
  $('#dlgMove').returnValue = '';
  $('#dlgMove').showModal();
  loadMoveList();
}
async function loadMoveList() {
  const ul = $('#moveList');
  const moving = new Set(MV.items.map(f => f.id));
  const at = MV.at;
  if (!at) {     // tingkat paling atas: pilih drive
    $('#moveCrumbs').innerHTML = `<span class="current">Komputer ini</span>`;
    ul.innerHTML = S.drives.map(d => `<li><button type="button" data-move-go="${d.id}">${diskSvg(d, 'mv-disk')}<span>${esc(driveName(d))}</span><span class="chev">${icon('i-chevron-right')}</span></button></li>`).join('');
    $('#moveOk').disabled = true;
    return;
  }
  ul.innerHTML = '<li class="hint">Memuat…</li>';
  const drv = isDriveRoot(at) ? at : driveOfFolder(at);
  const chain = isDriveRoot(at) ? [] : await folderChain(at);
  const d = driveById(drv);
  let ch = `<button type="button" data-move-top>Komputer ini</button><span class="sep">${icon('i-chevron-right')}</span>`;
  ch += chain.length ? `<button type="button" data-move-go="${drv}">${esc(d ? driveName(d) : 'Drive')}</button>` : `<span class="current">${esc(d ? driveName(d) : 'Drive')}</span>`;
  chain.forEach((c, i) => {
    ch += `<span class="sep">${icon('i-chevron-right')}</span>`;
    ch += i === chain.length - 1 ? `<span class="current">${esc(c.name)}</span>` : `<button type="button" data-move-go="${c.id}">${esc(c.name)}</button>`;
  });
  $('#moveCrumbs').innerHTML = ch;
  try {
    const folders = (await listAll(`'${qstr(at)}' in parents and mimeType='${FOLDER}' and trashed=false`, { orderBy: 'name' }));
    if (MV.at !== at) return;
    for (const f of folders) S.meta.set(f.id, { name: f.name, parents: f.parents });
    ul.innerHTML = folders.length ? folders.map(f => `<li><button type="button" data-move-go="${f.id}" ${moving.has(f.id) ? 'disabled title="Tidak bisa memindahkan folder ke dalam dirinya sendiri"' : ''}>${icon('i-folder')}<span>${esc(f.name)}</span><span class="chev">${icon('i-chevron-right')}</span></button></li>`).join('')
      : `<li class="hint">Tidak ada subfolder. Anda bisa ${MV.mode === 'copy' ? 'menyalin' : 'memindahkan'} ke sini.</li>`;
  } catch (e) { ul.innerHTML = '<li class="hint">Gagal memuat folder.</li>'; fail(e); }
  const same = MV.items.every(f => (f.parents || [])[0] === at);
  const inside = chain.some(c => moving.has(c.id));
  $('#moveOk').disabled = (MV.mode !== 'copy' && same) || inside;
}
function doMove() { return MV.mode === 'copy' ? copyItems(MV.items, MV.at) : moveItemsTo(MV.items, MV.at); }

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
  const tDrive = driveOfFolder(target);
  const incoming = list.filter(f => driveOfFolder((f.parents || [])[0]) !== tDrive)
    .reduce((n, f) => n + (isFolder(f) ? folderSize(f.id).bytes : Number(f.size) || 0), 0);
  if (!(await fitsInDrive(target, incoming))) return;
  const ids = new Set(list.map(f => f.id));
  if (!isDriveRoot(target)) {
    const chain = await folderChain(target);
    if (chain.some(c => ids.has(c.id))) { toast('Folder tidak bisa dipindahkan ke dalam dirinya sendiri.', { error: true }); return; }
  }
  try {
    await runAll(list, f => api('/files/' + f.id, { method: 'PATCH', query: {
      addParents: target, removeParents: (f.parents || []).join(','), fields: 'id,parents' } }));
    for (const f of list) { f.parents = [target]; if (isFolder(f)) S.meta.set(f.id, { name: f.name, parents: [target] }); }
    const name = (S.meta.get(target) || {}).name || 'folder';
    toast(list.length === 1 ? `“${list[0].name}” dipindahkan ke “${name}”.` : `${list.length} item dipindahkan ke “${name}”.`, {
      action: 'Buka', onAction: () => location.hash = folderHash(target) });
    if (S.route.type === 'folder' && S.route.id !== target) S.items = S.items.filter(f => !ids.has(f.id));
    S.selected.clear(); render(); refreshTreeSoon(); refreshQuotaSoon();
  } catch (e) { fail(e, 'Gagal memindahkan'); }
}

const LP = { timer: null, fired: false, x: 0, y: 0 };
/* ---- seret ke desktop: file disiapkan dulu di browser (Google tidak mengizinkan unduhan lewat alamat ber-token) ---- */
const DL = { ready: new Map(), busy: new Map(), order: [], hint: null };
const DRAG_OUT_MAX = 80e6;
function prepareDragOut(f) {
  if (!f || isFolder(f) || isGoogleDoc(f) || Number(f.size) > DRAG_OUT_MAX || DL.ready.has(f.id) || DL.busy.has(f.id)) return;
  const job = fetchBlob(f).then(blob => {
    DL.ready.set(f.id, URL.createObjectURL(blob));
    DL.order.push({ id: f.id, size: Number(f.size) || 0 });
    let total = DL.order.reduce((n, x) => n + x.size, 0);
    while (total > 200e6 && DL.order.length > 1) {        // simpan paling banyak ±200 MB
      const old = DL.order.shift(); total -= old.size;
      URL.revokeObjectURL(DL.ready.get(old.id)); DL.ready.delete(old.id);
    }
  }).catch(() => {}).finally(() => DL.busy.delete(f.id));
  DL.busy.set(f.id, job);
}
/* ---------------------------------------------------------------- seret-pindah di dalam aplikasi */
const DRAG = { ids: null };
function dropTargetOf(el) {
  if (!el || !el.closest) return null;
  const it = el.closest('#items .it');
  if (it) { const f = itemById(it.dataset.id); return f && isFolder(f) ? { el: it, id: f.id } : null; }
  const d = el.closest('[data-drop]');
  if (d) return { el: d, id: d.dataset.drop };
  const nav = el.closest('.nav a[data-nav="trash"]');
  if (nav) return { el: nav, id: '__trash' };
  return null;
}
function bindDrag() {
  let ghost = null, hover = null;
  const clearHover = () => { if (hover) hover.classList.remove('drop-hover'); hover = null; };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.target.closest && e.target.closest('#items .it') && (!S.token || Date.now() > S.exp - 120000)) getToken(true).catch(() => {});
  }, true);
  document.addEventListener('dragstart', (e) => {
    const it = e.target.closest && e.target.closest('#items .it');
    if (!it || S.route.type === 'trash') { if (it) e.preventDefault(); return; }
    if (!S.selected.has(it.dataset.id)) selectOnly(it.dataset.id);
    DRAG.ids = [...S.selected];
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('application/x-vena', DRAG.ids.join(','));
    e.dataTransfer.setData('text/plain', selectedItems().map(f => f.name).join('\n'));
    // seret ke desktop / Explorer (Chrome & Edge): file langsung diunduh ke tempat dilepas
    const one = selectedItems();
    if (one.length === 1 && !isFolder(one[0]) && !isGoogleDoc(one[0])) {
      const f = one[0], ready = DL.ready.get(f.id);
      if (ready) {
        try { e.dataTransfer.setData('DownloadURL', `${f.mimeType || 'application/octet-stream'}:${f.name.replace(/:/g, '_')}:${ready}`); } catch {}
      } else if (lastPointerType === 'mouse') {
        prepareDragOut(f);
        DL.hint = f.id;
      }
    }
    if (DRAG.ids.length > 1) {
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = `${DRAG.ids.length} item`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 16);
    }
    for (const id of DRAG.ids) { const el = $(`#items .it[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add('dragging'); }
  });
  document.addEventListener('dragend', (e) => {
    if (DL.hint && e.dataTransfer && e.dataTransfer.dropEffect === 'none') {
      const f = itemById(DL.hint);
      if (f && Number(f.size) <= DRAG_OUT_MAX) toast(`“${f.name}” sedang disiapkan. Tunggu sebentar lalu seret lagi ke desktop.`, { ms: 4000 });
      else if (f) toast('File di atas 80 MB tidak bisa diseret ke desktop. Pakai tombol Unduh.', { ms: 5000 });
    }
    DL.hint = null;
    DRAG.ids = null; clearHover();
    if (ghost) { ghost.remove(); ghost = null; }
    for (const el of $$('#items .it.dragging')) el.classList.remove('dragging');
  });
  const crossIds = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('application/x-vena');
  document.addEventListener('dragover', (e) => {
    if (!DRAG.ids && crossIds(e)) {           // diseret dari jendela lain
      const t = dropTargetOf(e.target) || (S.route.type === 'folder' && e.target.closest && e.target.closest('#content') ? { el: $('#content'), id: S.route.id } : null);
      if (!t) return;
      e.preventDefault(); e.dataTransfer.dropEffect = (e.ctrlKey || e.altKey) ? 'copy' : 'move';
      if (hover !== t.el) { clearHover(); hover = t.el; hover.classList.add('drop-hover'); }
      return;
    }
    if (!DRAG.ids) return;
    const t = dropTargetOf(e.target);
    if (!t || DRAG.ids.includes(t.id)) { clearHover(); e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = (e.ctrlKey || e.altKey) && t.id !== '__trash' ? 'copy' : 'move';
    if (hover !== t.el) { clearHover(); hover = t.el; hover.classList.add('drop-hover'); }
  });
  document.addEventListener('drop', async (e) => {
    if (!DRAG.ids && crossIds(e)) {
      e.preventDefault(); clearHover();
      const t = dropTargetOf(e.target) || (S.route.type === 'folder' ? { id: S.route.id } : null);
      const ids = (e.dataTransfer.getData('application/x-vena') || '').split(',').filter(Boolean);
      if (!t || !ids.length) return;
      const list = await itemsFromIds(ids);
      if (t.id === '__trash') trashItems(list);
      else if (e.ctrlKey || e.altKey) copyItems(list, t.id); else moveItemsTo(list, t.id);
      return;
    }
    if (!DRAG.ids) return;
    const t = dropTargetOf(e.target);
    e.preventDefault();
    clearHover();
    const list = S.items.filter(f => DRAG.ids.includes(f.id));
    DRAG.ids = null;
    if (!t || !list.length) return;
    if (t.id === '__trash') trashItems(list);
    else if (e.ctrlKey || e.altKey) copyItems(list, t.id);
    else moveItemsTo(list, t.id);
  });
}

/* ================================================================ MODE TERTANAM & SINKRON
   Model Desktop dan Dua panel memakai beberapa "Vena mini" (iframe) sekaligus.
   - EMBED = 'window' (jendela di Desktop) atau 'pane' (panel di Dua panel).
   - Perubahan di satu jendela memberi tahu jendela lain lewat BroadcastChannel. */
const EMBED = new URLSearchParams(location.search).get('embed') || '';
const toParent = (msg) => { if (EMBED && window.parent !== window) window.parent.postMessage(Object.assign({ vena: true }, msg), location.origin); };
const sync = ('BroadcastChannel' in window) ? new BroadcastChannel('vena-sync') : null;
let syncTimer = null, syncInTimer = null;
function notifySync() { if (!sync) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => sync.postMessage({ t: 'changed' }), 500); }
if (sync) sync.onmessage = () => {
  clearTimeout(syncInTimer);
  syncInTimer = setTimeout(() => {
    if (!S.rootId) return;
    if (!$('#screenApp').hidden && S.route.type !== 'drives') loadView(true);
    refreshQuotaSoon();
    if (typeof refreshDesktop === 'function') refreshDesktop();
  }, 400);
};
// file dari jendela lain yang diseret ke sini
async function itemsFromIds(ids) {
  const out = [];
  for (const id of ids) {
    const f = itemById(id) || await api('/files/' + id, { query: { fields: FIELDS } }).catch(() => null);
    if (f) out.push(f);
  }
  return out;
}
// perintah dari jendela utama (Desktop / Dua panel)
const PANE = { other: null, otherName: '' };
window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin || !e.data || !e.data.vena || !EMBED) return;
  const m = e.data, sel = selectedItems();
  if (m.type === 'other') { PANE.other = m.folder; PANE.otherName = m.name || ''; return; }
  if (m.type === 'go') { location.hash = m.hash; return; }
  if (m.type === 'focus-items') { const first = $('#items .it'); if (first) first.focus(); return; }
  if (m.type !== 'cmd') return;
  const need = () => { if (!sel.length) { toast('Pilih file atau folder dulu.'); return false; } return true; };
  switch (m.cmd) {
    case 'view': if (sel[0]) openItem(sel[0]); else toast('Pilih file dulu.'); break;
    case 'rename': if (sel.length === 1) renameItem(sel[0]); else toast('Pilih satu item untuk diganti namanya.'); break;
    case 'copy': if (need()) { if (!PANE.other) return toast('Panel lain belum membuka folder.'); copyItems(sel, PANE.other); } break;
    case 'move': if (need()) { if (!PANE.other) return toast('Panel lain belum membuka folder.'); moveItemsTo(sel, PANE.other); } break;
    case 'mkdir': newFolder(); break;
    case 'delete': if (need()) { if (S.route.type === 'trash') deleteItems(sel); else trashItems(sel); } break;
    case 'zip': if (need()) downloadFiles(sel); break;
    case 'refresh': loadView(); break;
  }
});
function reportRoute() {
  if (!EMBED) return;
  const folder = S.route.type === 'folder' ? S.route.id : null;
  toParent({ type: 'route', folder, hash: location.hash || '#/', title: $('#winTitle').textContent });
}

/* ================================================================ MODEL TAMPILAN */
const SKINS = ['classic', 'desktop', 'commander'];
const getSkin = () => { const s = LS.get('vena.skin'); return SKINS.includes(s) ? s : 'classic'; };
const isMultiSkin = () => !EMBED && getSkin() !== 'classic';
function applySkin(sk) {
  const c = document.documentElement.classList;
  c.remove('skin-modern', 'skin-desktop', 'skin-commander');
  if (!EMBED && sk !== 'classic') c.add('skin-' + sk);
  const v = $('#skinVal'); if (v) v.textContent = { classic: 'Klasik', desktop: 'Desktop', commander: 'Dua panel' }[sk];
  for (const b of $$('.skin-opt')) b.setAttribute('aria-pressed', String(b.dataset.skin === sk));
}
function setSkin(sk) {
  LS.set('vena.skin', sk);
  applySkin(sk);
  if (S.rootId) enterSkin();
}
function openSkinDialog() { closeMenus(); closeStart(); applySkin(getSkin()); $('#dlgSkin').showModal(); }
// tampilkan layar sesuai model (dipanggil setelah login & saat model diganti)
function enterSkin() {
  const sk = getSkin();
  if (EMBED || sk === 'classic') { leaveMulti(); show('screenApp'); return; }
  if (sk === 'desktop') { leaveCommander(); show('screenDesktop'); enterDesktop(); }
  else { leaveDesktop(); show('screenCmd'); enterCommander(); }
}
function leaveMulti() { leaveDesktop(); leaveCommander(); }
const embedSrc = (mode, hash) => `./?embed=${mode}${hash && hash !== '#/' ? hash : '#/'}`;
// pesan dari jendela/panel di dalam
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || !e.data.vena || EMBED) return;
  const w = OS.wins.find(x => x.frame && x.frame.contentWindow === e.source);
  if (w) return osMessage(w, e.data);
  const pi = CM.frames.findIndex(f => f && f.contentWindow === e.source);
  if (pi >= 0) return cmdrMessage(pi, e.data);
});
function refreshDesktop() {
  if (!$('#screenDesktop').hidden) { renderOsIcons(); renderOsStart(); }
  if (!$('#screenDesktop').hidden || !$('#screenCmd').hidden) updateFreeText();
}
function updateFreeText() {
  const q = S.quota || {}, lim = Number(q.limit) || 0, used = Number(q.usage) || 0;
  const t = lim ? `${fmtSize(Math.max(0, lim - used))} kosong` : '';
  if ($('#osFree')) $('#osFree').textContent = t;
  if ($('#cmdrFree')) $('#cmdrFree').textContent = t;
}

/* ---------------------------------------------------------------- DESKTOP OS */
const OS = { wins: [], z: 20, seq: 0, clock: null, active: null };
const OS_SPECIAL = [
  { hash: '#/recent', label: 'Terbaru', icon: 'i-clock' },
  { hash: '#/starred', label: 'Berbintang', icon: 'i-star' },
  { hash: '#/shared', label: 'Dibagikan', icon: 'i-link' },
  { hash: '#/trash', label: 'Sampah', icon: 'i-trash', drop: '__trash' },
];
function enterDesktop() {
  renderOsIcons(); renderOsStart(); updateFreeText();
  if (!OS.clock) { const tick = () => { $('#osClock').textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }; tick(); OS.clock = setInterval(tick, 15000); }
  if (!OS.wins.length) {
    let saved = [];
    try { saved = JSON.parse(LS.get('vena.osWins') || '[]'); } catch {}
    if (saved.length) for (const s of saved.slice(0, 8)) openWindow(s.hash, s.title, s);
  }
  $('#screenDesktop').classList.toggle('os-mobile', innerWidth <= 900);
}
function leaveDesktop() {
  for (const w of [...OS.wins]) w.el.remove();
  OS.wins = []; $('#osTasks') && ($('#osTasks').innerHTML = '');
  if (OS.clock) { clearInterval(OS.clock); OS.clock = null; }
}
function renderOsIcons() {
  const icons = S.drives.map(d => `<button class="os-icon" data-os-open="${folderHash(d.id)}" data-os-title="${esc(driveName(d))}" data-drive="${d.id}" data-drop="${d.id}">
      <span class="os-icon-img">${diskSvg(d, 'os-disk')}</span><span class="os-icon-lbl">${esc(driveName(d))}</span></button>`).join('')
    + OS_SPECIAL.map(s => `<button class="os-icon" data-os-open="${s.hash}" data-os-title="${s.label}"${s.drop ? ` data-drop="${s.drop}"` : ''}>
      <span class="os-icon-img sp">${icon(s.icon)}</span><span class="os-icon-lbl">${s.label}</span></button>`).join('');
  $('#osIcons').innerHTML = icons;
}
function renderOsStart() {
  const u = S.user || {};
  $('#osUser').textContent = u.displayName || 'Vena';
  $('#osEmail').textContent = u.emailAddress || '';
  $('#osAvatar').textContent = (u.displayName || 'V').trim()[0].toUpperCase();
  $('#osStartDrives').innerHTML = S.drives.map(d => `<button data-os-open="${folderHash(d.id)}" data-os-title="${esc(driveName(d))}">${diskSvg(d, 'os-sdisk')}<span><strong>${esc(driveName(d))}</strong><small>${esc(usageText(d))}</small></span></button>`).join('');
}
function toggleStart() { const s = $('#osStart'); s.hidden = !s.hidden; }
function closeStart() { const s = $('#osStart'); if (s) s.hidden = true; }

function openWindow(hash, title, geo) {
  closeStart();
  const mobile = innerWidth <= 900;
  const n = OS.wins.length;
  const W = Math.min(980, innerWidth - 120), H = Math.min(620, innerHeight - 140);
  const g = Object.assign({ x: 140 + (n % 6) * 34, y: 24 + (n % 6) * 30, w: W, h: H, max: false, min: false }, geo || {});
  const id = 'w' + (++OS.seq);
  const el = document.createElement('div');
  el.className = 'dwin';
  el.dataset.wid = id;
  el.innerHTML = `<div class="dwin-bar">
      <span class="dwin-ico">${icon('i-folder')}</span><span class="dwin-title">${esc(title || 'Vena')}</span>
      <button class="dwin-btn" data-wact="min" title="Kecilkan">${icon('i-minus')}</button>
      <button class="dwin-btn" data-wact="max" title="Besarkan">${icon('i-square')}</button>
      <button class="dwin-btn close" data-wact="close" title="Tutup">${icon('i-x')}</button>
    </div>
    <div class="dwin-body"><iframe title="${esc(title || 'Vena')}" src="${embedSrc('window', hash)}"></iframe></div>
    <span class="dwin-rs" data-wrs></span>`;
  $('#osWindows').appendChild(el);
  const w = { id, el, frame: el.querySelector('iframe'), hash, title: title || 'Vena', g };
  OS.wins.push(w);
  placeWin(w);
  if (g.max || mobile) setMax(w, true);
  if (g.min) setMin(w, true); else focusWin(w);
  renderTasks(); saveWins();
  return w;
}
function placeWin(w) {
  const { x, y, w: ww, h } = w.g;
  Object.assign(w.el.style, { left: Math.max(0, x) + 'px', top: Math.max(0, y) + 'px', width: Math.max(320, ww) + 'px', height: Math.max(220, h) + 'px' });
}
function focusWin(w) {
  if (!w) return;
  OS.active = w.id;
  w.el.style.zIndex = ++OS.z;
  for (const x of OS.wins) x.el.classList.toggle('active', x === w);
  renderTasks();
}
function setMin(w, on) { w.g.min = on; w.el.classList.toggle('min', on); if (on && OS.active === w.id) { OS.active = null; for (const x of OS.wins) x.el.classList.remove('active'); } renderTasks(); saveWins(); }
function setMax(w, on) { w.g.max = on; w.el.classList.toggle('max', on); saveWins(); }
function closeWin(w) { w.el.remove(); OS.wins = OS.wins.filter(x => x !== w); renderTasks(); saveWins(); }
function arrangeWins() {
  closeStart();
  const vis = OS.wins.filter(w => !w.g.min);
  const cols = Math.ceil(Math.sqrt(vis.length || 1)), rows = Math.ceil((vis.length || 1) / cols);
  const area = { x: 120, y: 10, w: innerWidth - 130, h: innerHeight - 70 };
  vis.forEach((w, i) => {
    setMax(w, false);
    w.g = Object.assign(w.g, { x: area.x + (i % cols) * area.w / cols, y: area.y + Math.floor(i / cols) * area.h / rows, w: area.w / cols - 8, h: area.h / rows - 8 });
    placeWin(w);
  });
  saveWins();
}
function renderTasks() {
  $('#osTasks').innerHTML = OS.wins.map(w => `<button class="os-task${OS.active === w.id ? ' on' : ''}${w.g.min ? ' min' : ''}" data-task="${w.id}" title="${esc(w.title)}">${icon('i-folder')}<span>${esc(w.title)}</span></button>`).join('');
}
let saveT;
function saveWins() {
  clearTimeout(saveT);
  saveT = setTimeout(() => LS.set('vena.osWins', JSON.stringify(OS.wins.map(w => ({ hash: w.hash, title: w.title, x: w.g.x, y: w.g.y, w: w.g.w, h: w.g.h, max: w.g.max, min: w.g.min })))), 300);
}
function osMessage(w, m) {
  if (m.type === 'title') {
    w.title = m.title; w.hash = m.hash || w.hash;
    w.el.querySelector('.dwin-title').textContent = m.title;
    renderTasks(); saveWins();
  } else if (m.type === 'route') { w.hash = m.hash || w.hash; saveWins(); }
  else if (m.type === 'open') openWindow(m.hash, m.title);
}
function bindDesktop() {
  const os = $('#screenDesktop');
  // buka ikon: klik dua kali (mouse) / ketuk (layar sentuh)
  os.addEventListener('click', (e) => {
    const t = e.target;
    if (!t.closest('#osStart') && !t.closest('[data-action="os-start"]')) closeStart();
    const op = t.closest('[data-os-open]');
    if (op && (op.closest('#osStart') || lastPointerType === 'touch')) { openWindow(op.dataset.osOpen, op.dataset.osTitle); return; }
    if (op) { for (const i of $$('.os-icon')) i.classList.toggle('sel', i === op); return; }
    const task = t.closest('[data-task]');
    if (task) {
      const w = OS.wins.find(x => x.id === task.dataset.task);
      if (w.g.min) { setMin(w, false); focusWin(w); } else if (OS.active === w.id) setMin(w, true); else focusWin(w);
      return;
    }
    const wb = t.closest('[data-wact]');
    if (wb) {
      const w = OS.wins.find(x => x.id === wb.closest('.dwin').dataset.wid);
      if (wb.dataset.wact === 'min') setMin(w, true);
      else if (wb.dataset.wact === 'max') setMax(w, !w.g.max);
      else closeWin(w);
      return;
    }
    if (t === os || t.closest('#osIcons') === t) for (const i of $$('.os-icon')) i.classList.remove('sel');
  });
  os.addEventListener('dblclick', (e) => {
    const op = e.target.closest('.os-icon[data-os-open]');
    if (op) { openWindow(op.dataset.osOpen, op.dataset.osTitle); return; }
    const bar = e.target.closest('.dwin-bar');
    if (bar && !e.target.closest('[data-wact]')) { const w = OS.wins.find(x => x.id === bar.closest('.dwin').dataset.wid); setMax(w, !w.g.max); }
  });
  // geser & ubah ukuran jendela
  os.addEventListener('pointerdown', (e) => {
    const winEl = e.target.closest('.dwin');
    if (winEl) focusWin(OS.wins.find(x => x.id === winEl.dataset.wid));
    const bar = e.target.closest('.dwin-bar'), rs = e.target.closest('[data-wrs]');
    if ((!bar && !rs) || e.target.closest('[data-wact]') || e.button !== 0) return;
    const w = OS.wins.find(x => x.id === winEl.dataset.wid);
    if (w.g.max || innerWidth <= 900) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, g0 = Object.assign({}, w.g);
    $('#osWindows').classList.add('dragging');
    const move = (ev) => {
      if (rs) { w.g.w = Math.max(320, g0.w + ev.clientX - sx); w.g.h = Math.max(220, g0.h + ev.clientY - sy); }
      else { w.g.x = Math.min(innerWidth - 80, Math.max(-g0.w + 120, g0.x + ev.clientX - sx)); w.g.y = Math.min(innerHeight - 90, Math.max(0, g0.y + ev.clientY - sy)); }
      placeWin(w);
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); $('#osWindows').classList.remove('dragging'); saveWins(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  // klik di dalam jendela (iframe) → jendela itu jadi aktif
  window.addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    if (a && a.tagName === 'IFRAME') closeStart();
    if (a && a.tagName === 'IFRAME') { const w = OS.wins.find(x => x.frame === a); if (w && OS.active !== w.id) focusWin(w); }
    const pi = CM.frames.indexOf(a); if (pi >= 0) setPane(pi);
  }, 0));
  os.addEventListener('contextmenu', (e) => {
    const d = e.target.closest('.os-icon[data-drive]');
    if (d) { e.preventDefault(); openDriveMenu(d.dataset.drive, e.clientX, e.clientY, false); }
  });
  window.addEventListener('resize', () => $('#screenDesktop').classList.toggle('os-mobile', innerWidth <= 900));
}
let lastPointerType = 'mouse';
document.addEventListener('pointerdown', (e) => { lastPointerType = e.pointerType || 'mouse'; }, true);

/* ---------------------------------------------------------------- DUA PANEL */
const CM = { frames: [null, null], folders: [null, null], names: ['', ''], active: 0 };
function enterCommander() {
  updateFreeText();
  if (CM.frames[0]) return;
  let saved = [];
  try { saved = JSON.parse(LS.get('vena.cmdrPanes') || '[]'); } catch {}
  const second = S.drives[1] ? S.drives[1].id : S.rootId;
  const hashes = [saved[0] || folderHash(S.rootId), saved[1] || folderHash(second)];
  $$('.cmdr-pane').forEach((p, i) => {
    p.innerHTML = `<iframe title="Panel ${i ? 'kanan' : 'kiri'}" src="${embedSrc('pane', hashes[i])}"></iframe>`;
    CM.frames[i] = p.querySelector('iframe');
  });
  setPane(0);
}
function leaveCommander() {
  $$('.cmdr-pane').forEach(p => { p.innerHTML = ''; });
  CM.frames = [null, null]; CM.folders = [null, null];
}
function setPane(i) {
  CM.active = i;
  $$('.cmdr-pane').forEach((p, n) => p.classList.toggle('active', n === i));
  $$('[data-pane-tab]').forEach((b, n) => b.classList.toggle('on', n === i));
  $('#fArrow1').textContent = $('#fArrow2').textContent = i === 0 ? '→' : '←';
}
function cmdrMessage(i, m) {
  if (m.type === 'focus') setPane(i);
  else if (m.type === 'tab') { setPane(1 - i); CM.frames[1 - i].focus(); CM.frames[1 - i].contentWindow.postMessage({ vena: true, type: 'focus-items' }, location.origin); }
  else if (m.type === 'route' || m.type === 'title') {
    if (m.folder !== undefined) CM.folders[i] = m.folder;
    if (m.title) CM.names[i] = m.title;
    const o = CM.frames[1 - i];
    if (o) o.contentWindow.postMessage({ vena: true, type: 'other', folder: CM.folders[i], name: CM.names[i] }, location.origin);
    const me = CM.frames[i];
    if (me && CM.folders[1 - i]) me.contentWindow.postMessage({ vena: true, type: 'other', folder: CM.folders[1 - i], name: CM.names[1 - i] }, location.origin);
    LS.set('vena.cmdrPanes', JSON.stringify(CM.frames.map((f, n) => CM.folders[n] ? folderHash(CM.folders[n]) : null)));
  }
}
function cmdrSend(cmd) {
  const f = CM.frames[CM.active];
  if (f) { f.contentWindow.postMessage({ vena: true, type: 'cmd', cmd }, location.origin); f.focus(); }
}
function bindCommander() {
  $('#screenCmd').addEventListener('click', (e) => {
    const fb = e.target.closest('[data-fcmd]');
    if (fb) { cmdrSend(fb.dataset.fcmd); return; }
    const tab = e.target.closest('[data-pane-tab]');
    if (tab) { setPane(Number(tab.dataset.paneTab)); return; }
  });
  document.addEventListener('keydown', (e) => {
    if ($('#screenCmd').hidden || document.querySelector('dialog[open]')) return;
    const fk = { F2: 'rename', F3: 'view', F5: 'copy', F6: 'move', F7: 'mkdir', F8: 'delete' }[e.key];
    if (fk) { e.preventDefault(); cmdrSend(fk); }
    else if (e.key === 'Tab') { e.preventDefault(); setPane(1 - CM.active); CM.frames[CM.active] && CM.frames[CM.active].focus(); }
  });
}

/* ================================================================ PASANG APLIKASI (PWA) */
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function updateInstallUI() {
  for (const b of $$('[data-action="install"]')) b.hidden = isStandalone();
}
async function installApp() {
  closeMenus();
  if (installEvt) {
    installEvt.prompt();
    const r = await installEvt.userChoice.catch(() => ({}));
    installEvt = null;
    if (r.outcome === 'accepted') toast('Vena sedang dipasang di perangkat Anda.');
    updateInstallUI();
    return;
  }
  $('#installIos').hidden = !isIOS();
  $('#installOther').hidden = isIOS();
  $('#dlgInstall').showModal();
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; updateInstallUI(); });
window.addEventListener('appinstalled', () => { installEvt = null; updateInstallUI(); toast('Vena sudah terpasang. Buka dari layar utama.'); });

/* ================================================================ TOMBOL KEMBALI & KELUAR
   - Tombol kembali (HP / browser) menutup layar yang sedang terbuka dulu
     (pratinjau, video, menu samping), lalu mundur antar folder.
   - Di halaman awal, tombol kembali menampilkan dialog "Keluar dari Vena?". */
const NAV = { overlays: [], ignorePop: 0, guard: false, leaving: false };
function installBackGuard() {
  if (NAV.guard || EMBED) return;
  NAV.guard = true;
  history.replaceState({ vena: 'base' }, '');
  history.pushState({ vena: 'app' }, '');
}
function pushOverlay(name) {
  if (!NAV.guard) return;
  NAV.overlays.push(name);
  history.pushState({ vena: 'overlay', name }, '');
}
function popOverlay(name) {
  const i = NAV.overlays.lastIndexOf(name);
  if (i < 0) return;
  NAV.overlays.splice(i, 1);
  NAV.ignorePop++;
  history.back();
}
function forgetOverlay(name) { const i = NAV.overlays.lastIndexOf(name); if (i >= 0) NAV.overlays.splice(i, 1); }
function closeOverlayFromBack(name) {
  if (name === 'viewer') closeViewer(true);
  else if (name === 'video') stopPlayer(true);
  else if (name === 'nav') $('#screenApp').classList.remove('nav-open');
}
async function onPopState(e) {
  if (NAV.ignorePop) { NAV.ignorePop--; return; }
  if (NAV.leaving) return;
  if (NAV.overlays.length) { closeOverlayFromBack(NAV.overlays.pop()); return; }
  if (e.state && e.state.vena === 'base' && !$('#screenApp').hidden) {
    const ok = await confirmDialog('Keluar dari Vena?', 'Anda akan menutup aplikasi penyimpanan.', 'Keluar');
    if (!ok) { history.pushState({ vena: 'app' }, ''); return; }
    NAV.leaving = true;
    try { if (P.list.length) stopPlayer(true); } catch {}
    history.back();
    setTimeout(() => {               // aplikasi terpasang di HP tidak bisa ditutup dari dalam halaman
      if (document.visibilityState === 'visible') {
        NAV.leaving = false;
        toast('Tekan tombol kembali sekali lagi untuk keluar.', { ms: 3000 });
      }
    }, 400);
  }
}
async function confirmLogout() {
  const ok = await confirmDialog('Keluar dari akun?', 'Anda perlu memasukkan password lagi untuk membuka Vena.', 'Keluar');
  if (ok) logout();
}

/* ================================================================ PEMUTAR MUSIK & VIDEO
   - Musik: bilah pemutar di bawah jendela, tetap berbunyi saat pindah folder.
   - Video: layar video dengan daftar putar, lanjut otomatis ke video berikutnya.
   - Diputar langsung dari Drive (streaming); kalau tidak bisa, diunduh dulu.
   - Kontrol di layar kunci HP / tombol media keyboard (Media Session). */
const P = { list: [], order: [], pos: -1, kind: null, shuffle: false, repeat: 'off', blobUrl: null, streamOk: false, triedRefresh: 0, usingBlob: false };
const mediaKind = (f) => { const k = kindOf(f); return (k === 'audio' || k === 'video') && !isGoogleDoc(f) ? k : null; };
const curTrack = () => P.list[P.order[P.pos]];
const mediaEl = () => P.kind === 'video' ? $('#plVideo') : $('#plAudio');
const fmtTime = (s) => { if (!isFinite(s)) return '0:00'; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

function playList(list, startId, kind) {
  list = list.filter(f => mediaKind(f) === kind);
  if (!list.length) return;
  stopPlayer(true);
  P.list = list; P.kind = kind;
  P.order = list.map((_, i) => i);
  const start = Math.max(0, list.findIndex(f => f.id === startId));
  if (P.shuffle) shuffleOrder(start); else P.pos = start;
  if (kind === 'video') { $('#videoStage').hidden = false; document.body.style.overflow = 'hidden'; pushOverlay('video'); }
  else { $('#player').hidden = false; $('#screenApp').classList.add('playing'); }
  renderPlaylist();
  loadTrack();
}
function shuffleOrder(keepIdx) {
  const rest = P.list.map((_, i) => i).filter(i => i !== keepIdx);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  P.order = [keepIdx, ...rest]; P.pos = 0;
}
function cleanupBlob() { if (P.blobUrl) { URL.revokeObjectURL(P.blobUrl); P.blobUrl = null; } }
const streamUrl = (f, token) => `${API}/files/${encodeURIComponent(f.id)}?alt=media&access_token=${encodeURIComponent(token)}`;

async function loadTrack(resumeAt = 0) {
  const f = curTrack(); if (!f) return;
  const el = mediaEl();
  cleanupBlob();
  P.streamOk = false; P.usingBlob = false; P.triedRefresh = 0;
  $('#vsMsg').hidden = true;
  renderNowPlaying();
  // Google menolak token di alamat (403), jadi file diambil dengan izin resmi lalu diputar
  el.removeAttribute('src');
  $('#plSub') && P.kind === 'audio' && ($('#plSub').textContent = 'Memuat…');
  return fallbackToBlob(resumeAt);
}
async function fallbackToBlob(resumeAt) {
  const f = curTrack(); if (!f) return;
  const el = mediaEl();
  const at = resumeAt || el.currentTime || 0;
  const size = Number(f.size) || 0;
  if (size > (P.kind === 'video' ? 600e6 : 200e6)) { mediaError('File ini terlalu besar untuk diputar di sini. Unduh dulu untuk memutarnya.'); return; }
  P.usingBlob = true;
  $('#plSub').textContent = 'Memuat…';
  try {
    const blob = PRE.id === f.id && PRE.blob ? PRE.blob : await fetchBlob(f);
    if (curTrack() !== f) return;
    P.blobUrl = URL.createObjectURL(blob.type && blob.type !== 'application/octet-stream' ? blob : new Blob([blob], { type: f.mimeType || '' }));
    el.src = P.blobUrl;
    if (at) el.currentTime = at;
    preloadNext();
    el.play().catch(() => {});
    renderNowPlaying();
  } catch (e) { mediaError('File tidak bisa diputar: ' + e.message); }
}
function mediaError(msg) {
  if (P.kind === 'video') { $('#vsMsg').textContent = msg; $('#vsMsg').hidden = false; }
  else toast(msg, { error: true });
  // lompat ke berikutnya kalau ini daftar putar
  if (P.list.length > 1) setTimeout(() => stepTrack(1, true), 1500);
}
const PRE = { id: null, blob: null };
async function preloadNext() {
  if (P.kind !== 'audio' || P.order.length < 2) return;
  const nf = P.list[P.order[(P.pos + 1) % P.order.length]];
  if (!nf || PRE.id === nf.id || Number(nf.size) > 60e6) return;
  PRE.id = nf.id; PRE.blob = null;
  try { const b = await fetchBlob(nf); if (PRE.id === nf.id) PRE.blob = b; } catch { PRE.id = null; }
}
async function onMediaError(e) {
  if (!curTrack()) return;
  const el = mediaEl();
  if (e && e.target !== el) return;          // elemen lain yang baru dihentikan
  if (!el.getAttribute('src')) return;
  if (P.usingBlob) { mediaError('Format file ini tidak didukung browser.'); return; }
  if (P.streamOk && P.triedRefresh < 2) {          // token habis di tengah lagu → sambung lagi
    P.triedRefresh++;
    const at = el.currentTime;
    try { const t = await getToken(true); el.src = streamUrl(curTrack(), t); el.currentTime = at; el.play().catch(() => {}); return; } catch {}
  }
  fallbackToBlob();
}
function stepTrack(d, auto = false) {
  if (!P.list.length) return;
  const el = mediaEl();
  if (d < 0 && el.currentTime > 4) { el.currentTime = 0; return; }   // seperti pemutar musik biasa
  let pos = P.pos + d;
  if (pos >= P.order.length) {
    if (P.repeat === 'all' || !auto) pos = 0;
    else { el.pause(); renderNowPlaying(); return; }
  }
  if (pos < 0) pos = P.order.length - 1;
  P.pos = pos;
  renderPlaylist();
  loadTrack();
}
function playAt(listIdx) {
  P.pos = Math.max(0, P.order.indexOf(listIdx));
  renderPlaylist(); loadTrack();
}
function togglePlay() {
  const el = mediaEl(); if (!curTrack()) return;
  if (el.paused) el.play().catch(() => {}); else el.pause();
}
function toggleShuffle() {
  P.shuffle = !P.shuffle;
  const cur = P.order[P.pos];
  if (P.shuffle) shuffleOrder(cur); else { P.order = P.list.map((_, i) => i); P.pos = cur; }
  LS.set('vena.shuffle', P.shuffle ? '1' : '0');
  renderPlaylist(); renderNowPlaying();
}
function cycleRepeat() {
  P.repeat = P.repeat === 'off' ? 'all' : P.repeat === 'all' ? 'one' : 'off';
  LS.set('vena.repeat', P.repeat);
  renderNowPlaying();
  toast(P.repeat === 'all' ? 'Ulangi semua' : P.repeat === 'one' ? 'Ulangi satu lagu' : 'Ulangi mati', { ms: 1500 });
}
function stopPlayer(silent) {
  for (const el of [$('#plAudio'), $('#plVideo')]) { el.pause(); el.removeAttribute('src'); el.load(); }
  cleanupBlob();
  const wasVideo = !$('#videoStage').hidden;
  $('#player').hidden = true; $('#videoStage').hidden = true; $('#plList').hidden = true;
  $('#screenApp').classList.remove('playing');
  if (wasVideo) { document.body.style.overflow = ''; if (!silent) popOverlay('video'); else forgetOverlay('video'); }
  P.list = []; P.order = []; P.pos = -1; P.kind = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
}

/* ---- tampilan ---- */
function trackArt(f) {
  const t = TH.mem.get(f.id) || blobThumbs.get(f.id);
  return t ? `<img alt="" src="${t}">` : `<svg viewBox="0 0 24 24"><use href="#s-${P.kind === 'video' ? 'video' : 'musik'}"/></svg>`;
}
const trackTitle = (f) => f.name.replace(/\.[^.]+$/, '');
function renderNowPlaying() {
  const f = curTrack(); if (!f) return;
  const el = mediaEl();
  const n = `${P.pos + 1} dari ${P.order.length}`;
  const playing = !el.paused;
  for (const id of ['#plPlay', '#vsPlay']) $(id + ' use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  for (const id of ['#plShuffle', '#vsShuffle']) $(id).setAttribute('aria-pressed', String(P.shuffle));
  for (const id of ['#plRepeat', '#vsRepeat']) {
    $(id).setAttribute('aria-pressed', String(P.repeat !== 'off'));
    $(id + ' use').setAttribute('href', P.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
  }
  if (P.kind === 'audio') {
    $('#plTitle').textContent = trackTitle(f);
    $('#plSub').textContent = n + (P.shuffle ? ', acak' : '');
    $('#plArt').innerHTML = trackArt(f);
  } else {
    $('#vsTitle').textContent = f.name;
    $('#vsSub').textContent = n;
  }
  for (const li of $$('#plItems li, #vsItems li')) li.classList.toggle('on', Number(li.dataset.i) === P.order[P.pos]);
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: trackTitle(f), artist: CFG.APP_NAME, album: $('#winTitle').textContent || '',
        artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch {}
  }
}
function renderPlaylist() {
  const rows = P.order.map((i, n) => {
    const f = P.list[i];
    return `<li data-i="${i}" class="${n === P.pos ? 'on' : ''}"><button type="button" data-play-idx="${i}"><span class="n">${n + 1}</span><span class="t">${esc(trackTitle(f))}</span><span class="s">${esc(fmtSize(f.size))}</span></button></li>`;
  }).join('');
  $('#plItems').innerHTML = rows; $('#vsItems').innerHTML = rows;
  $('#plCount').textContent = `${P.list.length} ${P.kind === 'video' ? 'video' : 'lagu'}`;
  renderNowPlaying();
}
function bindPlayer() {
  for (const el of [$('#plAudio'), $('#plVideo')]) {
    el.addEventListener('playing', () => { P.streamOk = true; renderNowPlaying(); });
    el.addEventListener('pause', renderNowPlaying);
    el.addEventListener('play', renderNowPlaying);
    el.addEventListener('ended', () => {
      if (P.repeat === 'one') { el.currentTime = 0; el.play().catch(() => {}); }
      else stepTrack(1, true);
    });
    el.addEventListener('error', onMediaError);
  }
  const a = $('#plAudio'), seek = $('#plSeek');
  let dragging = false;
  a.addEventListener('timeupdate', () => {
    $('#plCur').textContent = fmtTime(a.currentTime);
    $('#plDur').textContent = fmtTime(a.duration);
    if (!dragging && a.duration) seek.value = Math.round(a.currentTime / a.duration * 1000);
    if ('mediaSession' in navigator && a.duration && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: a.duration, position: a.currentTime, playbackRate: a.playbackRate }); } catch {}
    }
  });
  seek.addEventListener('input', () => { dragging = true; $('#plCur').textContent = fmtTime(seek.value / 1000 * (a.duration || 0)); });
  seek.addEventListener('change', () => { if (a.duration) a.currentTime = seek.value / 1000 * a.duration; dragging = false; });
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (k, fn) => { try { ms.setActionHandler(k, fn); } catch {} };
    set('play', () => mediaEl().play());
    set('pause', () => mediaEl().pause());
    set('previoustrack', () => stepTrack(-1));
    set('nexttrack', () => stepTrack(1));
    set('seekto', (d) => { mediaEl().currentTime = d.seekTime; });
  }
  P.shuffle = LS.get('vena.shuffle') === '1';
  P.repeat = LS.get('vena.repeat') || 'off';
}

/* putar semua media di folder (termasuk subfolder) */
async function playFolder(folder) {
  const p = progressToast('Menyiapkan daftar putar');
  p.set('Mencari musik & video…', null);
  const found = [];
  try {
    const walk = async (id, depth) => {
      if (depth > 6 || found.length > 1000) return;
      const kids = await listAll(`'${qstr(id)}' in parents and trashed=false`, { orderBy: 'folder,name' });
      for (const k of sorted(kids)) {
        if (isFolder(k)) await walk(k.id, depth + 1);
        else if (mediaKind(k)) found.push(k);
      }
    };
    await walk(folder.id, 0);
  } catch (e) { p.close(); fail(e); return; }
  p.close();
  const audio = found.filter(f => mediaKind(f) === 'audio'), video = found.filter(f => mediaKind(f) === 'video');
  if (!audio.length && !video.length) { toast('Tidak ada musik atau video di folder ini.'); return; }
  if (audio.length) playList(audio, audio[0].id, 'audio'); else playList(video, video[0].id, 'video');
}
function playAllHere() {
  const files = visibleFiles();
  const audio = files.filter(f => mediaKind(f) === 'audio');
  const video = files.filter(f => mediaKind(f) === 'video');
  if (audio.length) playList(audio, audio[0].id, 'audio');
  else if (video.length) playList(video, video[0].id, 'video');
}
function updatePlayAllButton() {
  const has = S.route.type !== 'trash' && visibleFiles().some(f => mediaKind(f));
  $('#cmdPlay').hidden = !has;
}

/* ================================================================ PRATINJAU */
const V = { id: null, url: null, ctl: null, pdf: null, wb: null, zoom: 1 };
function viewerFiles() { return visibleFiles(); }
async function openViewer(id) {
  const f = itemById(id); if (!f) return;
  V.id = id;
  if (V.ctl) V.ctl.abort();
  if (V.url) { URL.revokeObjectURL(V.url); V.url = null; }
  if (V.pdf) { try { V.pdf.destroy(); } catch {} V.pdf = null; }
  const list = viewerFiles().filter(x => !mediaKind(x));
  const idx = list.findIndex(x => x.id === id);
  $('.viewer-nav.prev').hidden = idx <= 0;
  $('.viewer-nav.next').hidden = idx < 0 || idx >= list.length - 1;
  $('#viewerName').textContent = f.name;
  $('#viewerMeta').textContent = [fmtSize(f.size), fmtDate(f.modifiedTime)].filter(Boolean).join(', ');
  $('#viewerOpenDrive').href = f.webViewLink || '#';
  if ($('#viewer').hidden) pushOverlay('viewer');
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  const body = $('#viewerBody');
  body.className = 'viewer-body';
  const k = kindOf(f), size = Number(f.size) || 0, e = extOf(f), mime = f.mimeType || '';
  const msg = (text) => {
    body.className = 'viewer-body';
    body.innerHTML = `<div class="viewer-msg">${itemSvg(f, 'big')}<p>${esc(text)}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <button class="btn btn-primary" data-action="viewer-download">${icon('i-download')}Unduh</button></div></div>`;
  };
  const loading = (t) => { body.className = 'viewer-body'; body.innerHTML = `<div class="viewer-loading"><div class="spinner"></div><p>${esc(t || 'Memuat…')}</p></div>`; };

  // jenis tampilan
  const textual = (k === 'code' || mime.startsWith('text/') || ['txt', 'md', 'log', 'json', 'xml'].includes(e)) && e !== 'csv';
  const gdoc = mime.startsWith('application/vnd.google-apps.');
  const convertible = ['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp'].includes(e) || (k === 'doc' && !textual && e !== 'pages') || (k === 'slides' && e !== 'key');
  let mode = null;
  if (gdoc) mode = ['document', 'presentation', 'spreadsheet', 'drawing'].some(t => mime.endsWith(t)) ? 'gexport' : null;
  else if (k === 'image') mode = 'image';
  else if (k === 'pdf') mode = 'pdf';
  else if (k === 'sheet') mode = 'sheet';
  else if (textual) mode = 'text';
  else if (convertible) mode = 'convert';
  const limits = { image: 40e6, pdf: 120e6, sheet: 25e6, text: 3e6, convert: 50e6, gexport: Infinity };
  if (!mode) return msg('Pratinjau belum tersedia untuk jenis file ini. Unduh untuk membukanya.');
  if (size > limits[mode]) return msg('File ini terlalu besar untuk dipratinjau di sini. Unduh untuk membukanya.');

  loading(mode === 'convert' || mode === 'gexport' ? 'Menyiapkan pratinjau dokumen…' : 'Memuat…');
  V.ctl = new AbortController();
  const signal = V.ctl.signal;
  try {
    if (mode === 'gexport') {
      const res = await api(`/files/${f.id}/export`, { query: { mimeType: 'application/pdf' }, raw: true, signal });
      if (V.id !== id) return;
      return await renderPdf(await res.arrayBuffer(), id);
    }
    if (mode === 'convert') {
      const data = await officeToPdf(f, signal);
      if (V.id !== id) return;
      return await renderPdf(data, id);
    }
    const blob = await fetchBlob(f, signal);
    if (V.id !== id) return;
    if (mode === 'text') {
      const t = await blob.text();
      body.innerHTML = '<pre></pre>'; body.firstChild.textContent = t;
    } else if (mode === 'image') {
      V.url = URL.createObjectURL(blob);
      body.className = 'viewer-body img-mode';
      body.innerHTML = `<img alt="${esc(f.name)}" src="${V.url}" title="Klik untuk memperbesar">`;
      body.firstChild.onclick = (ev) => {          // klik: ukuran asli ⇄ pas layar
        const z = body.classList.toggle('zoomed');
        if (z) {
          const img = ev.target, r = img.getBoundingClientRect();
          const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
          requestAnimationFrame(() => { body.scrollLeft = img.scrollWidth * fx - body.clientWidth / 2; body.scrollTop = img.scrollHeight * fy - body.clientHeight / 2; });
        }
      };
    } else if (mode === 'pdf') {
      await renderPdf(await blob.arrayBuffer(), id);
    } else if (mode === 'sheet') {
      await renderSheet(await blob.arrayBuffer(), e, id);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (V.id === id) msg(err.auth ? 'Sesi habis. Masuk lagi lalu coba buka file ini.' : 'Pratinjau tidak bisa dibuat: ' + err.message);
  }
}

/* ---- pemuat pustaka (hanya diunduh saat dibutuhkan) ---- */
const libCache = {};
function loadScript(src) {
  if (!libCache[src]) libCache[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => { delete libCache[src]; reject(new Error('Komponen pratinjau gagal dimuat. Periksa koneksi internet.')); };
    document.head.appendChild(s);
  });
  return libCache[src];
}
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
async function loadPdfJs() {
  await loadScript(PDFJS + 'pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  return window.pdfjsLib;
}

/* ---- Word / PowerPoint → PDF lewat Google Drive (file sementara langsung dihapus) ---- */
const pdfCache = new Map();
async function officeToPdf(f, signal) {
  const key = f.id + '|' + f.modifiedTime;
  if (pdfCache.has(key)) return pdfCache.get(key).slice(0);
  const k = kindOf(f);
  const target = k === 'slides' ? 'application/vnd.google-apps.presentation' : 'application/vnd.google-apps.document';
  const tmp = await api(`/files/${f.id}/copy`, { method: 'POST', query: { fields: 'id' }, signal,
    body: { name: '~pratinjau ' + f.name, mimeType: target, parents: [S.rootId], appProperties: { venaTemp: '1' } } });
  try {
    const res = await api(`/files/${tmp.id}/export`, { query: { mimeType: 'application/pdf' }, raw: true, signal });
    const buf = await res.arrayBuffer();
    if (pdfCache.size > 8) pdfCache.delete(pdfCache.keys().next().value);
    pdfCache.set(key, buf.slice(0));
    return buf;
  } catch (e) {
    if (/too large|exportSizeLimit/i.test(e.message)) throw new Error('dokumen terlalu besar untuk diubah ke pratinjau');
    throw e;
  } finally {
    api(`/files/${tmp.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

/* ---- penampil PDF (jalan di semua perangkat, termasuk HP) ---- */
async function renderPdf(data, id) {
  const pdfjsLib = await loadPdfJs();
  if (V.id !== id) return;
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
  if (V.id !== id) { pdf.destroy(); return; }
  V.pdf = pdf; V.zoom = 1;
  const body = $('#viewerBody');
  body.className = 'viewer-body doc-mode';
  body.innerHTML = `<div class="pdf-scroll" id="pdfScroll"><div class="pdf-pages" id="pdfPages"></div></div>
    <div class="doc-bar">
      <button class="pb" data-action="pdf-zoom-out" title="Perkecil"><svg class="i"><use href="#i-minus"/></svg></button>
      <span id="pdfZoom">100%</span>
      <button class="pb" data-action="pdf-zoom-in" title="Perbesar"><svg class="i"><use href="#i-plus"/></svg></button>
      <span class="doc-sep"></span>
      <span id="pdfPage">1 / ${pdf.numPages}</span>
    </div>`;
  const first = await pdf.getPage(1);
  V.pageBase = first.getViewport({ scale: 1 });
  layoutPdf();
  const sc = $('#pdfScroll');
  sc.addEventListener('scroll', () => {
    const pages = $$('#pdfPages .pdf-page');
    const mid = sc.scrollTop + sc.clientHeight / 3;
    let n = 1;
    for (const p of pages) { if (p.offsetTop <= mid) n = Number(p.dataset.n); else break; }
    $('#pdfPage').textContent = `${n} / ${pdf.numPages}`;
  }, { passive: true });
}
function layoutPdf() {
  const pdf = V.pdf; if (!pdf) return;
  const sc = $('#pdfScroll'), wrap = $('#pdfPages');
  const fitW = Math.max(240, Math.min((sc.clientWidth || window.innerWidth) - 24, 1000));
  const cssW = Math.round(fitW * V.zoom);
  const cssH = Math.round(cssW * V.pageBase.height / V.pageBase.width);
  $('#pdfZoom').textContent = Math.round(V.zoom * 100) + '%';
  wrap.innerHTML = Array.from({ length: pdf.numPages }, (_, i) =>
    `<div class="pdf-page" data-n="${i + 1}" style="width:${cssW}px;height:${cssH}px"></div>`).join('');
  if (V.pdfObs) V.pdfObs.disconnect();
  V.pdfObs = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) { V.pdfObs.unobserve(en.target); drawPdfPage(en.target, cssW); }
  }, { root: sc, rootMargin: '600px 0px' });
  for (const el of $$('#pdfPages .pdf-page')) V.pdfObs.observe(el);
}
async function drawPdfPage(el, cssW) {
  const pdf = V.pdf; if (!pdf) return;
  try {
    const page = await pdf.getPage(Number(el.dataset.n));
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: cssW / base.width * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = cssW + 'px'; c.style.height = Math.round(cssW * base.height / base.width) + 'px';
    el.style.height = c.style.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (el.isConnected) { el.innerHTML = ''; el.appendChild(c); }
  } catch {}
}
function zoomPdf(d) {
  if (!V.pdf) return;
  const sc = $('#pdfScroll');
  const ratio = sc.scrollTop / (sc.scrollHeight || 1);
  V.zoom = Math.max(0.5, Math.min(3, Math.round((V.zoom + d) * 4) / 4));
  layoutPdf();
  sc.scrollTop = ratio * sc.scrollHeight;
}

/* ---- penampil Excel / CSV ---- */
async function renderSheet(data, ext, id) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  if (V.id !== id) return;
  const wb = window.XLSX.read(new Uint8Array(data), { type: 'array', cellDates: true, dense: false, codepage: 65001 });
  V.wb = wb;
  const body = $('#viewerBody');
  body.className = 'viewer-body doc-mode';
  const tabs = wb.SheetNames.length > 1
    ? `<div class="sheet-tabs">${wb.SheetNames.map((n, i) => `<button type="button" data-sheet="${i}">${esc(n)}</button>`).join('')}</div>` : '';
  body.innerHTML = `<div class="sheet-wrap" id="sheetWrap"></div>${tabs}`;
  showSheet(0);
}
function showSheet(i) {
  const wb = V.wb; if (!wb) return;
  const ws = wb.Sheets[wb.SheetNames[i]];
  const MAX = 3000;
  let note = '';
  if (ws['!ref']) {
    const r = window.XLSX.utils.decode_range(ws['!ref']);
    if (r.e.r - r.s.r + 1 > MAX) {
      note = `<p class="sheet-note">Menampilkan ${MAX.toLocaleString('id-ID')} baris pertama dari ${(r.e.r - r.s.r + 1).toLocaleString('id-ID')}. Unduh untuk melihat semuanya.</p>`;
      r.e.r = r.s.r + MAX - 1;
      ws['!ref'] = window.XLSX.utils.encode_range(r);
    }
  }
  const html = ws['!ref'] ? window.XLSX.utils.sheet_to_html(ws, { header: '', footer: '' }) : '<p class="sheet-note">Sheet ini kosong.</p>';
  const wrap = $('#sheetWrap');
  wrap.innerHTML = note + html;
  // tambah nomor kolom (A, B, C …) supaya mudah dibaca seperti di Excel
  const t = wrap.querySelector('table');
  if (t && t.rows.length) {
    const cols = Math.max(...[...t.rows].slice(0, 50).map(r => [...r.cells].reduce((s, c) => s + (c.colSpan || 1), 0)));
    const head = t.createTHead().insertRow(0);
    head.insertCell().outerHTML = '<th class="corner"></th>';
    for (let c = 0; c < cols; c++) head.insertCell().outerHTML = `<th>${window.XLSX.utils.encode_col(c)}</th>`;
    [...t.tBodies[0].rows].forEach((r, n) => { const th = document.createElement('th'); th.textContent = n + 1; r.insertBefore(th, r.firstChild); });
  }
  for (const b of $$('.sheet-tabs button')) b.classList.toggle('on', Number(b.dataset.sheet) === i);
}

function closeViewer(fromBack) {
  if (!fromBack && !$('#viewer').hidden) popOverlay('viewer'); else forgetOverlay('viewer');
  if (V.ctl) V.ctl.abort();
  if (V.pdf) { try { V.pdf.destroy(); } catch {} V.pdf = null; }
  if (V.pdfObs) { V.pdfObs.disconnect(); V.pdfObs = null; }
  V.wb = null;
  if (V.url) { URL.revokeObjectURL(V.url); V.url = null; }
  V.id = null;
  $('#viewerBody').innerHTML = '';
  $('#viewer').hidden = true;
  document.body.style.overflow = '';
}
function stepViewer(d) {
  const list = viewerFiles().filter(x => !mediaKind(x));
  const i = list.findIndex(x => x.id === V.id);
  const n = list[i + d];
  if (n) openViewer(n.id);
}

/* ================================================================ UNGGAH */
const U = { tasks: [], active: 0, max: 3, seq: 0, folderCache: new Map() };

async function addUploads(entries, baseParent) {
  // entries: [{file, dir: ['A','B']}]
  if (!entries.length) return;
  if (!(await fitsInDrive(baseParent, entries.reduce((n, e) => n + (e.file.size || 0), 0)))) return;
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
  t.status = 'uploading'; t.loaded = t.offset || 0; t.error = ''; t.retrying = false;
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

/* Unggahan "resumable" per potongan 8 MB. Kalau koneksi putus, unggahan
   menunggu sebentar lalu melanjutkan dari bagian terakhir yang sudah diterima
   Google — bukan dari nol. Tombol ⟳ juga melanjutkan sesi yang sama. */
const CHUNK = 8 * 1024 * 1024;   // kelipatan 256 KB, sesuai aturan Google
const abortErr = () => Object.assign(new Error('Dibatalkan'), { aborted: true });

async function startUploadSession(file, type, parentId, retried) {
  const meta = { name: file.name, parents: [parentId] };
  if (file.lastModified) meta.modifiedTime = new Date(file.lastModified).toISOString();
  const token = await getToken();
  let r;
  try {
    r = await fetch(`${UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(file.size) },
      body: JSON.stringify(meta),
    });
  } catch { throw new Error('Koneksi terputus'); }
  if (r.status === 401 && !retried) { S.token = null; return startUploadSession(file, type, parentId, true); }
  if (!r.ok) {
    let m = 'Ditolak Google Drive (' + r.status + ')'; try { m = (await r.json()).error.message; } catch {}
    if (/quota/i.test(m)) m = 'Ruang Google Drive sudah penuh';
    throw Object.assign(new Error(m), { fatal: true });
  }
  return r.headers.get('Location');   // null kalau browser tidak diizinkan membacanya
}

// kirim satu potongan [start, end) — hasil: {done, data} atau {next}
function putChunk(t, start, end, type) {
  return new Promise((resolve, reject) => {
    const file = t.file;
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('PUT', t.session);
    xhr.setRequestHeader('Content-Type', type);
    if (file.size > 0) xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${file.size}`);
    let last = 0;
    xhr.upload.onprogress = (e) => {
      t.loaded = start + e.loaded;
      const now = Date.now();
      if (now - last > 150) { last = now; renderUploadRow(t); }
    };
    xhr.onload = () => {
      t.xhr = null;
      handleChunkResponse(xhr, end, resolve, reject);
    };
    xhr.onerror = () => { t.xhr = null; reject(new Error('Koneksi terputus')); };
    xhr.onabort = () => { t.xhr = null; reject(abortErr()); };
    xhr.send(file.size > 0 ? file.slice(start, end) : null);
  });
}
// tanya Google: sudah sampai byte ke berapa?
function queryUpload(t) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('PUT', t.session);
    xhr.setRequestHeader('Content-Range', `bytes */${t.file.size}`);
    xhr.onload = () => { t.xhr = null; handleChunkResponse(xhr, null, resolve, reject); };
    xhr.onerror = () => { t.xhr = null; reject(new Error('Koneksi terputus')); };
    xhr.onabort = () => { t.xhr = null; reject(abortErr()); };
    xhr.send();
  });
}
function handleChunkResponse(xhr, assumedNext, resolve, reject) {
  const st = xhr.status;
  if (st === 200 || st === 201) {
    let data = null; try { data = JSON.parse(xhr.responseText); } catch {}
    return resolve({ done: true, data });
  }
  if (st === 308) {
    const range = xhr.getResponseHeader('Range');           // "bytes=0-1234"
    const m = range && /-(\d+)$/.exec(range);
    return resolve({ next: m ? Number(m[1]) + 1 : (assumedNext !== null ? assumedNext : 0) });
  }
  if (st === 404 || st === 410) return reject(Object.assign(new Error('Sesi unggahan kedaluwarsa'), { expired: true }));
  if (st >= 500 || st === 429 || st === 0) return reject(new Error('Server sibuk (' + st + ')'));
  let m = 'Gagal (' + st + ')'; try { m = JSON.parse(xhr.responseText).error.message; } catch {}
  if (/quota/i.test(m)) m = 'Ruang Google Drive sudah penuh';
  reject(Object.assign(new Error(m), { fatal: true }));
}

async function sendFile(t, parentId) {
  const file = t.file;
  const type = file.type || 'application/octet-stream';
  if (!t.session || t.sessionParent !== parentId) {
    t.session = await startUploadSession(file, type, parentId);
    t.sessionParent = parentId; t.offset = 0;
    if (!t.session) return sendMultipart(t, parentId, type);
  }
  let fails = 0;
  for (;;) {
    if (t.status === 'cancelled') throw abortErr();
    const start = t.offset || 0;
    const end = Math.min(file.size, start + CHUNK);
    try {
      const res = await putChunk(t, start, end, type);
      fails = 0;
      if (res.done) { t.loaded = file.size; t.session = null; t.offset = 0; return res.data; }
      t.offset = res.next; t.loaded = res.next;
    } catch (e) {
      if (e.aborted || t.status === 'cancelled') throw abortErr();
      if (e.fatal) { t.session = null; t.offset = 0; throw e; }
      if (e.expired) {                       // sesi hangus → mulai sesi baru
        t.session = await startUploadSession(file, type, parentId); t.offset = 0;
        if (!t.session) return sendMultipart(t, parentId, type);
        continue;
      }
      if (++fails > 8) { t.retrying = false; throw new Error('Koneksi terputus. Klik ⟳ untuk melanjutkan.'); }
      t.retrying = true; renderUploadRow(t);
      await sleep(Math.min(30000, 1000 * 2 ** fails));
      if (t.status === 'cancelled') throw abortErr();
      try {
        const st = await queryUpload(t);
        if (st.done) { t.retrying = false; t.loaded = file.size; t.session = null; return st.data; }
        t.offset = st.next; t.loaded = st.next;
      } catch (e2) {
        if (e2.aborted) throw abortErr();
        if (e2.expired) { t.session = await startUploadSession(file, type, parentId); t.offset = 0; }
      }
      t.retrying = false;
    }
  }
}

// cadangan bila sesi resumable tidak bisa dipakai
function sendMultipart(t, parentId, type) {
  return new Promise(async (resolve, reject) => {
    const file = t.file;
    const meta = { name: file.name, parents: [parentId] };
    let token;
    try { token = await getToken(); } catch (e) { return reject(e); }
    const b = 'vena' + Math.random().toString(36).slice(2);
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, file, `\r\n--${b}--`]);
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('POST', `${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}`);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + b);
    let last = 0;
    xhr.upload.onprogress = (e) => {
      t.loaded = e.loaded / (e.total || 1) * file.size;
      const now = Date.now();
      if (now - last > 150) { last = now; renderUploadRow(t); }
    };
    xhr.onload = () => {
      t.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) { t.loaded = file.size; let d = null; try { d = JSON.parse(xhr.responseText); } catch {} resolve(d); }
      else if (xhr.status === 401) { S.token = null; reject(new Error('Akses kedaluwarsa, coba lagi')); }
      else { let m = 'Gagal (' + xhr.status + ')'; try { m = JSON.parse(xhr.responseText).error.message; } catch {} reject(new Error(m)); }
    };
    xhr.onerror = () => { t.xhr = null; reject(new Error('Koneksi terputus')); };
    xhr.onabort = () => { t.xhr = null; reject(abortErr()); };
    xhr.send(body);
  });
}

let landTimer; const landed = new Set();
function landedIn(parentId) {
  notifySync();
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
    case 'uploading': return t.retrying ? `Koneksi terputus, menyambung lagi… (${fmtSize(t.loaded)} aman)` : `${fmtSize(t.loaded)} dari ${fmtSize(t.file.size)}`;
    case 'done': return 'Selesai' + (t.dir.length ? ' — ' + t.dir.join('/') : '');
    case 'failed': return (t.error || 'Gagal') + (t.session && t.offset ? ` — ${fmtSize(t.offset)} sudah tersimpan` : '');
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
  const base = S.uploadTarget || curFolderId();
  S.uploadTarget = null;
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
  applySkin(getSkin());
  for (const el of $$('[data-version]')) el.textContent = 'Versi ' + APP_VERSION;
  for (const el of $$('[data-version-long]')) el.textContent = `${CFG.APP_NAME} versi ${APP_VERSION} (${APP_BUILD})`;
  updateInstallUI();
  for (const el of $$('[data-appname]')) el.textContent = CFG.APP_NAME;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  setupLoginScreen();
  if (EMBED) document.title = CFG.APP_NAME;
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
  for (const b of $$('.seg button')) b.onclick = () => {
    S.view = b.dataset.view;
    S.viewBy[S.routeKey || '#/'] = S.view;            // diingat untuk folder ini saja
    const keys = Object.keys(S.viewBy); if (keys.length > 300) delete S.viewBy[keys[0]];
    LS.set('vena.viewBy', JSON.stringify(S.viewBy));
    render();
  };

  $('#pickFiles').onchange = (e) => { startUpload(e.target.files); e.target.value = ''; };
  $('#pickFolder').onchange = (e) => { startUpload(e.target.files); e.target.value = ''; };

  $('#shareToggle').onchange = (e) => setShared(e.target.checked);
  $('#shareExpiry').onchange = changeExpiry;
  $('#driveLabel').addEventListener('input', paintDriveDialog);
  $('#driveLetter').addEventListener('change', paintDriveDialog);
  $('#dlgMove').addEventListener('close', () => { if ($('#dlgMove').returnValue === 'ok') doMove(); });

  window.addEventListener('hashchange', () => { if (!$('#viewer').hidden) closeViewer(true); onRoute(); });
  window.addEventListener('popstate', onPopState);
  window.addEventListener('beforeunload', (e) => {
    if (EMBED || NAV.leaving || ($('#screenApp').hidden && !isMultiSkin())) return;
    if ($('#screenLogin') && !$('#screenLogin').hidden) return;
    e.preventDefault(); e.returnValue = '';      // browser menampilkan dialog "Tinggalkan situs?"
  });

  /* klik global (delegasi) */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    // aksi menu item
    const ia = t.closest('[data-item-action]');
    if (ia) { itemAction(ia.dataset.itemAction, ia.dataset.id); return; }
    if (t.closest('[data-go-home]')) { location.hash = '#/'; return; }
    if (t.closest('[data-move-top]')) { MV.at = null; loadMoveList(); return; }
    const da = t.closest('[data-drive-action]');
    if (da) { driveAction(da.dataset.driveAction, da.dataset.id); return; }
    const dm = t.closest('[data-drive-more]');
    if (dm) { e.stopPropagation(); const r = dm.getBoundingClientRect(); openDriveMenu(dm.dataset.driveMore, r.right, r.bottom + 4, true); return; }
    const dcol = t.closest('[data-dcolor]');
    if (dcol) { DD.color = dcol.dataset.dcolor; paintDriveDialog(); return; }
    const card = t.closest('.drv-card[data-drive]');
    if (card) { location.hash = folderHash(card.dataset.drive); return; }
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
        case 'new-drive': openDriveDialog(); return;
        case 'open-sidebar': $('#screenApp').classList.add('nav-open'); pushOverlay('nav'); return;
        case 'close-sidebar': if ($('#screenApp').classList.contains('nav-open')) { $('#screenApp').classList.remove('nav-open'); popOverlay('nav'); } return;
        case 'logout': confirmLogout(); return;
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
        case 'sel-copy': openMove(selectedItems(), 'copy'); return;
        case 'paste': pasteClip(); return;
        case 'install': installApp(); return;
        case 'skin': openSkinDialog(); return;
        case 'os-start': e.stopPropagation(); toggleStart(); return;
        case 'os-arrange': arrangeWins(); return;
        case 'cmdr-upload': { const f = CM.folders[CM.active]; if (!f) { toast('Buka folder di panel aktif dulu.'); return; } S.uploadTarget = f; $('#pickFiles').click(); return; }
        case 'pdf-zoom-in': zoomPdf(0.25); return;
        case 'pdf-zoom-out': zoomPdf(-0.25); return;
        case 'play-all': playAllHere(); return;
        case 'player-toggle': togglePlay(); return;
        case 'player-prev': stepTrack(-1); return;
        case 'player-next': stepTrack(1); return;
        case 'player-shuffle': toggleShuffle(); return;
        case 'player-repeat': cycleRepeat(); return;
        case 'player-list': {
          if (P.kind === 'video') $('#videoStage').classList.toggle('list-off');
          else { $('#plList').hidden = !$('#plList').hidden; $('#plListBtn').setAttribute('aria-pressed', String(!$('#plList').hidden)); }
          return;
        }
        case 'player-close': stopPlayer(); return;
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
        case 'send-wa': if (shareItem) sendVia('wa', shareItem, $('#shareLink').value); return;
        case 'send-tg': if (shareItem) sendVia('tg', shareItem, $('#shareLink').value); return;
        case 'send-mail': if (shareItem) sendVia('mail', shareItem, $('#shareLink').value); return;
        case 'send-native': if (shareItem) sendNative(shareItem, $('#shareLink').value); return;
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
    const sko = t.closest('[data-skin]');
    if (sko) { setSkin(sko.dataset.skin); return; }
    const sh = t.closest('[data-sheet]');
    if (sh) { showSheet(Number(sh.dataset.sheet)); return; }
    const pi = t.closest('[data-play-idx]');
    if (pi) { playAt(Number(pi.dataset.playIdx)); return; }
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
    if (item && LP.fired) { LP.fired = false; return; }       // habis tekan-lama
    if (item && t.closest('[data-more]')) {
      e.stopPropagation();
      const r = t.closest('[data-more]').getBoundingClientRect();
      openItemMenu(item.dataset.id, r.right, r.bottom + 4, true);
      return;
    }
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
  // tekan-lama di HP (termasuk iPhone yang tidak punya klik kanan) → menu item
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const it = e.target.closest && e.target.closest('#items .it');
    if (!it || e.target.closest('[data-more]')) return;
    LP.x = e.clientX; LP.y = e.clientY; LP.fired = false;
    clearTimeout(LP.timer);
    LP.timer = setTimeout(() => {
      LP.fired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      openItemMenu(it.dataset.id, LP.x, LP.y, false);
    }, 520);
  });
  const lpCancel = (e) => { if (e && e.type === 'pointermove' && Math.hypot(e.clientX - LP.x, e.clientY - LP.y) < 10) return; clearTimeout(LP.timer); };
  document.addEventListener('pointermove', lpCancel);
  document.addEventListener('pointerup', () => clearTimeout(LP.timer));
  document.addEventListener('pointercancel', () => clearTimeout(LP.timer));
  document.addEventListener('scroll', () => clearTimeout(LP.timer), true);

  document.addEventListener('dblclick', (e) => {
    const item = e.target.closest('#items .it');
    if (!item || lastPointer === 'touch') return;
    const f = itemById(item.dataset.id); if (f) openItem(f);
  });

  document.addEventListener('contextmenu', (e) => {
    if ($('#screenApp').hidden) return;
    const drv = e.target.closest && e.target.closest('[data-drive]');
    if (drv) { e.preventDefault(); openDriveMenu(drv.dataset.drive, e.clientX, e.clientY, false); return; }
    const item = e.target.closest('#items .it');
    if (item && lastPointer === 'touch') { e.preventDefault(); return; }
    if (item) {
      e.preventDefault();
      if (!S.selected.has(item.dataset.id)) selectOnly(item.dataset.id);
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
    if (!$('#videoStage').hidden) {
      if (e.key === 'Escape') stopPlayer();
      else if (e.key === 'MediaTrackNext' || (e.shiftKey && e.key === 'N')) stepTrack(1);
      return;
    }
    if (!$('#viewer').hidden) {
      if (V.pdf && (e.key === '+' || e.key === '=')) { zoomPdf(0.25); return; }
      if (V.pdf && e.key === '-') { zoomPdf(-0.25); return; }
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') stepViewer(-1);
      else if (e.key === 'ArrowRight') stepViewer(1);
      return;
    }
    if (e.key === 'Escape') {
      if ($('#osStart') && !$('#osStart').hidden) { closeStart(); return; }
      if ([...$$('.menu')].some(m => !m.hidden)) { closeMenus(); return; }
      clearSelection();
      $('#screenApp').classList.remove('nav-open');
      return;
    }
    if (typing || $('#screenApp').hidden || document.querySelector('dialog[open]')) return;
    const sel = selectedItems();
    if (EMBED === 'pane') {
      const fk = { F3: 'view', F5: 'copy', F6: 'move', F7: 'mkdir', F8: 'delete', F2: 'rename' }[e.key];
      if (fk) { e.preventDefault(); window.dispatchEvent(new MessageEvent('message', { origin: location.origin, data: { vena: true, type: 'cmd', cmd: fk } })); return; }
      if (e.key === 'Tab') { e.preventDefault(); toParent({ type: 'tab' }); return; }
    }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navStep(-1); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navStep(1); return; }
    if ((e.altKey && e.key === 'ArrowUp') || e.key === 'Backspace') { e.preventDefault(); navUp(); return; }
    if (e.key === 'F5') { e.preventDefault(); loadView(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel.length) { e.preventDefault(); setClip('copy'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && sel.length) { e.preventDefault(); setClip('cut'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && S.clip) { e.preventDefault(); pasteClip(); return; }
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
  bindPlayer();
  if (!EMBED) { bindDesktop(); bindCommander(); }
  if (EMBED) document.addEventListener('pointerdown', () => toParent({ type: 'focus' }), true);
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (V.pdf) layoutPdf(); }, 200); });

  /* seret & lepas file dari komputer */
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || $('#screenApp').hidden) return;
    e.preventDefault();
    dragDepth++;
    const name = S.route.type === 'folder' ? ((S.meta.get(S.route.id) || {}).name || 'folder ini') : (driveById(curDrive()) ? driveName(driveById(curDrive())) : 'drive C:');
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
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).catch(() => {}));
}

bind();
boot();
})();
