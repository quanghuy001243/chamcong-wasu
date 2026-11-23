// Chấm công WASU — web app (Firebase Auth + Firestore)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, collection, query, where, getDocs, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAlm0Nio8WSBdxYSL6xRCh9SmTmQM2sajk',
  authDomain: 'chamcong-wasu.firebaseapp.com',
  projectId: 'chamcong-wasu',
  storageBucket: 'chamcong-wasu.firebasestorage.app',
  messagingSenderId: '841862989122',
  appId: '1:841862989122:web:38ec38d46a535fbe0934db',
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const fs = getFirestore(fbApp);
let secAuth = null; // app phụ để tạo tài khoản nhân viên mà không đăng xuất quản lý
function secondaryAuth() {
  if (!secAuth) secAuth = getAuth(initializeApp(firebaseConfig, 'secondary'));
  return secAuth;
}

// ---------- trạng thái ----------
const S = {
  phase: 'loading', // loading | login | setup | app | inactive
  me: null, email: '', isAdmin: false, profile: null,
  config: { name: 'WASU', start: '08:30', end: '17:30', grace: 10, method: 'gps', loc: null, radius: 20 },
  presence: null, today: null, todayKey: dayKey(Date.now()),
  secret: null, secretLoaded: false,
  att: [], attLoaded: false, users: [], usersLoaded: false,
  view: 'home', busy: false,
  history: { month: monthNow(), rows: null, loading: false },
  report: { month: monthNow(), data: null, loading: false, open: null },
};
let subs = [];
let unsubToday = null;
const verifying = new Set();
const rendered20 = new Set();
let lastWin = null;

const nameOf = id => {
  if (id === S.me && S.profile?.name) return S.profile.name;
  const u = S.users.find(x => x.id === id);
  return (u && u.name) || 'Nhân viên';
};
const userOf = id => S.users.find(x => x.id === id);

// ---------- khởi động / đăng nhập ----------
function clearSubs() {
  subs.forEach(u => { try { u(); } catch {} });
  subs = [];
  if (unsubToday) { unsubToday(); unsubToday = null; }
}
onAuthStateChanged(auth, async u => {
  clearSubs();
  Object.assign(S, { me: null, isAdmin: false, profile: null, presence: null, today: null, secret: null, secretLoaded: false, att: [], attLoaded: false, users: [], usersLoaded: false });
  S.history = { month: monthNow(), rows: null, loading: false };
  S.report = { month: monthNow(), data: null, loading: false, open: null };
  if (!u) {
    try {
      const b = await getDoc(doc(fs, 'meta/bootstrap'));
      S.phase = b.exists() ? 'login' : 'setup';
    } catch { S.phase = 'login'; }
    render(); return;
  }
  S.me = u.uid; S.email = u.email || '';
  try {
    const [a, p] = await Promise.all([getDoc(doc(fs, `admins/${u.uid}`)), getDoc(doc(fs, `users/${u.uid}`))]);
    S.isAdmin = a.exists();
    S.profile = p.exists() ? p.data() : null;
  } catch (e) { S.isAdmin = false; S.profile = null; }
  if (!S.isAdmin && (!S.profile || S.profile.active !== true)) { S.phase = 'inactive'; render(); return; }
  S.phase = 'app';
  startSubs();
  route(true);
  render();
});

function startSubs() {
  subs.push(onSnapshot(doc(fs, 'config/office'), s => {
    if (s.exists()) S.config = Object.assign({}, S.config, s.data());
    render();
  }, () => {}));
  subs.push(onSnapshot(doc(fs, `users/${S.me}`), s => {
    S.profile = s.exists() ? s.data() : S.profile;
    if (!S.isAdmin && S.profile && S.profile.active !== true) { S.phase = 'inactive'; clearSubs(); }
    render();
  }, () => {}));
  subs.push(onSnapshot(doc(fs, `att/${S.me}`), s => {
    S.presence = s.exists() ? s.data() : null;
    render();
  }, () => {}));
  subscribeToday();
  if (S.isAdmin) {
    subs.push(onSnapshot(doc(fs, 'secure/kiosk'), s => {
      S.secret = s.exists() ? (s.data().secret || null) : null;
      S.secretLoaded = true;
      render(); verifyPending();
    }, () => { S.secretLoaded = true; render(); }));
    subs.push(onSnapshot(collection(fs, 'att'), q => {
      S.att = q.docs.map(d => Object.assign({ id: d.id }, d.data()));
      S.attLoaded = true;
      render(); verifyPending();
    }, () => { S.attLoaded = true; render(); }));
    subs.push(onSnapshot(collection(fs, 'users'), q => {
      S.users = q.docs.map(d => Object.assign({ id: d.id }, d.data()));
      S.usersLoaded = true;
      render();
    }, () => { S.usersLoaded = true; render(); }));
  }
}
function subscribeToday() {
  if (!S.me) return;
  if (unsubToday) unsubToday();
  S.today = null;
  unsubToday = onSnapshot(doc(fs, `att/${S.me}/days/${S.todayKey}`), s => {
    S.today = s.exists() ? s.data() : { date: S.todayKey, sessions: [] };
    render();
  }, () => {});
}

// Máy quản lý tự đối chiếu mã của lượt chấm mới nhất và báo lại cho nhân viên
async function verifyPending() {
  if (!S.isAdmin || !S.secret) return;
  for (const a of S.att) {
    const la = a.lastAction;
    if (!la || !la.key || !la.code) continue;
    if (a.lastCheck && a.lastCheck.key === la.key) continue;
    const k = a.id + '|' + la.key;
    if (verifying.has(k)) continue;
    verifying.add(k);
    const ok = verifyCode(S.secret, la.code, la.t);
    try { await updateDoc(doc(fs, `att/${a.id}`), { lastCheck: { key: la.key, ok, at: Date.now() } }); }
    catch (e) { verifying.delete(k); }
  }
}

// ---------- điều hướng ----------
const VIEWS = ['home', 'history', 'live', 'report', 'staff', 'kiosk', 'settings'];
const ADMIN_ONLY = ['live', 'report', 'staff', 'kiosk', 'settings'];
function route(first) {
  const h = (location.hash || '').replace('#', '');
  S.view = VIEWS.includes(h) && (S.isAdmin || !ADMIN_ONLY.includes(h)) ? h : 'home';
  if (first !== true) { render(); window.scrollTo(0, 0); }
}
window.addEventListener('hashchange', () => route());

// ---------- chấm công ----------
function errMsg(e) {
  const c = e && e.code;
  if (c === 'permission-denied') return 'Không lưu được: tài khoản chưa được kích hoạt, hoặc đồng hồ điện thoại đang lệch giờ. Hãy bật "Đặt giờ tự động" trên điện thoại rồi thử lại.';
  if (c === 'unavailable') return 'Mất kết nối mạng. Kiểm tra Wi-Fi/4G rồi thử lại.';
  return (e && e.message) || 'Không lưu được, thử lại.';
}
// ---------- định vị ----------
const method = () => S.config.method || 'gps';
const usesGps = () => method() === 'gps' || method() === 'both';
const usesCode = () => method() === 'code' || method() === 'both';
function distM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m';
function geoOk(g) {
  const loc = S.config.loc; if (!g || !loc) return false;
  const r = Number(S.config.radius) || 20;
  return distM(g, loc) <= r + Math.min(Number(g.acc) || 0, 30);
}
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject({ code: 'nogeo' });
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) }),
      e => reject(e), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
function parseLoc(text) {
  const t = String(text || '');
  const pats = [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/];
  for (const re of pats) { const m = t.match(re); if (m) { const lat = +m[1], lng = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }; } }
  return null;
}
function geoModal(html) {
  document.getElementById('modal').innerHTML = `<div class="modal-bg" data-close><div class="sheet">${html}</div></div>`;
  bindModalClose();
}
async function startCheck(kind, retry) {
  if (!usesGps()) return openCodeModal(kind, retry, null);
  if (!S.config.loc) { toast('Quản lý chưa cài đặt vị trí quán. Vui lòng báo quản lý.', true); return; }
  geoModal(`<div style="text-align:center;padding:16px 0"><div style="font-size:34px">📍</div><b style="font-size:17px">Đang xác định vị trí…</b><p class="muted" style="margin:6px 0 0;font-size:13.5px">Nếu điện thoại hỏi quyền vị trí, hãy chọn <b>Cho phép</b>.</p></div>`);
  let g;
  try { g = await getPosition(); }
  catch (e) {
    const denied = e && e.code === 1;
    geoModal(`<div class="row"><b style="font-size:17px">Không lấy được vị trí</b><button class="btn small" data-close-btn>Đóng</button></div>
      <p class="ink2" style="font-size:14px">${denied
        ? 'Bạn đã chặn quyền vị trí cho trang này. <br>• <b>iPhone</b>: Cài đặt → Quyền riêng tư & Bảo mật → Dịch vụ định vị → bật cho Safari (Khi dùng ứng dụng), rồi mở lại app.<br>• <b>Android</b>: bấm biểu tượng ổ khóa cạnh địa chỉ → Quyền → Vị trí → Cho phép.'
        : 'Hãy bật định vị (GPS) trên điện thoại, đứng chỗ thoáng hoặc bật Wi-Fi để định vị nhanh hơn, rồi thử lại.'}</p>
      <button class="bigbtn in" data-geo-retry>Thử lại</button>`);
    document.querySelector('[data-geo-retry]').onclick = () => startCheck(kind, retry);
    return;
  }
  const d = distM(g, S.config.loc); g.d = Math.round(d);
  if (!geoOk(g)) {
    geoModal(`<div class="row"><b style="font-size:17px">Bạn chưa ở ${esc(S.config.name)}</b><button class="btn small" data-close-btn>Đóng</button></div>
      <p class="ink2" style="font-size:14px">Vị trí của bạn cách quán khoảng <b>${fmtDist(d)}</b> (cho phép trong ${Number(S.config.radius) || 20} m).
      ${g.acc > 30 ? `<br>GPS đang kém chính xác (±${g.acc} m) — hãy bật Wi-Fi, ra gần cửa hoặc chờ vài giây rồi thử lại.` : ''}</p>
      <button class="bigbtn in" data-geo-retry>Thử lại</button>`);
    document.querySelector('[data-geo-retry]').onclick = () => startCheck(kind, retry);
    return;
  }
  if (usesCode()) return openCodeModal(kind, retry, g);
  doAction(kind, null, retry, g);
}

async function doAction(kind, code, retry, geo) {
  if (S.busy || !S.me) return;
  S.busy = true; closeModal(); render();
  try {
    const t = Date.now(), dk = dayKey(t);
    const dayRef = doc(fs, `att/${S.me}/days/${dk}`);
    const snap = await getDoc(dayRef);
    const d = snap.exists() ? clone(snap.data()) : { date: dk, sessions: [] };
    d.date = dk; d.sessions = d.sessions || [];
    const ss = d.sessions, last = ss[ss.length - 1];
    if (kind === 'in') {
      if (last && !last.out) { last.in = t; last.inCode = code; last.inGeo = geo || null; }
      else ss.push({ in: t, inCode: code, inGeo: geo || null, out: null, outCode: null, outGeo: null });
    } else {
      if (!last) throw new Error('Chưa có lượt check-in hôm nay.');
      if (last.out && !retry) throw new Error('Bạn đã check-out rồi.');
      last.out = t; last.outCode = code; last.outGeo = geo || null;
    }
    d.updatedAt = t;
    await setDoc(dayRef, d);
    const closed = ss.filter(s => s.out).reduce((a, s) => a + (s.out - s.in), 0);
    const idx = ss.length - 1;
    await setDoc(doc(fs, `att/${S.me}`), {
      status: kind === 'in' ? 'in' : 'out',
      since: kind === 'in' ? ss[idx].in : t,
      date: dk, todayClosedMs: closed, firstIn: ss[0].in, sessions: ss.length,
      lastAction: { key: `${dk}#${idx}#${kind}#${t}`, kind, t, code: code || null, geo: geo || null, method: method(), day: dk, idx },
      updatedAt: t,
    }, { merge: true });
    toast(kind === 'in' ? `Đã check-in lúc ${hm(t)}` : `Đã check-out lúc ${hm(t)}`);
  } catch (e) { toast(errMsg(e), true); }
  finally { S.busy = false; render(); }
}

function openCodeModal(kind, retry, geo) {
  const title = kind === 'in' ? 'Check-in vào làm' : 'Check-out ra về';
  const m = document.getElementById('modal');
  m.innerHTML = `
  <div class="modal-bg" data-close>
    <form class="sheet" id="codeForm">
      <div class="row" style="margin-bottom:4px"><b style="font-size:18px">${title}</b>
        <button type="button" class="btn small" data-close-btn>Đóng</button></div>
      <p class="ink2" style="margin:6px 0 16px">Nhập <b>mã 6 số</b> đang hiện trên màn hình chấm công tại ${esc(S.config.name)}. Mã đổi sau mỗi 30 giây.</p>
      <input class="codein" id="codeIn" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" required>
      <div id="codeErr" style="color:var(--red);font-size:13px;min-height:18px;margin:8px 2px"></div>
      <button class="bigbtn ${kind === 'in' ? 'in' : 'out'}" style="margin:4px 0 0" type="submit">${kind === 'in' ? 'Xác nhận check-in' : 'Xác nhận check-out'}</button>
    </form>
  </div>`;
  bindModalClose();
  const inp = document.getElementById('codeIn');
  inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); });
  setTimeout(() => inp.focus(), 60);
  document.getElementById('codeForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = inp.value.trim();
    if (!/^\d{6}$/.test(v)) { document.getElementById('codeErr').textContent = 'Mã gồm đúng 6 chữ số.'; return; }
    doAction(kind, v, retry, geo);
  });
}
function bindModalClose() {
  const m = document.getElementById('modal');
  const bg = m.querySelector('[data-close]');
  if (bg) bg.addEventListener('click', e => { if (e.target === bg) closeModal(); });
  m.querySelectorAll('[data-close-btn]').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() { document.getElementById('modal').innerHTML = ''; }
let toastT;
function toast(msg, bad) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.style.cssText = `position:fixed;left:50%;transform:translateX(-50%);bottom:88px;z-index:60;max-width:92vw;padding:11px 16px;border-radius:12px;font-weight:600;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.18);background:${bad ? '#7F1D1D' : '#14231C'};color:#fff`;
  el.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 5000);
}

// ---------- icon ----------
const IC = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  staff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.8-3.4 3.2-5 6-5s5.2 1.6 6 5"/><circle cx="18" cy="9" r="2.4"/><path d="M16.5 14.6c2.3.2 3.9 1.7 4.5 4.4"/></svg>',
  kiosk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7.5 10h1M11.5 10h1M15.5 10h1"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
};
const LABEL = { home: 'Chấm công', history: 'Lịch sử', live: 'Trực tiếp', report: 'Báo cáo', staff: 'Nhân viên', kiosk: 'Màn hình mã', settings: 'Cài đặt' };

function navHTML() {
  const list = S.isAdmin ? ['home', 'live', 'report', 'staff', ...(usesCode() ? ['kiosk'] : []), 'settings'] : ['home', 'history'];
  return `<nav class="tabs"><div class="in">${list.map(v => `<a href="#${v}" class="${S.view === v ? 'on' : ''}">${IC[v]}<span>${LABEL[v]}</span></a>`).join('')}</div></nav>`;
}
function topHTML() {
  const who = S.me ? `<div style="display:flex;align-items:center;gap:8px">${S.isAdmin ? '<span class="pill blue">Quản lý</span>' : ''}<button class="btn small" data-logout>Đăng xuất</button></div>` : '';
  return `<div class="top"><div class="brand"><div class="logo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5BD39A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
  <div><b>Chấm công</b><small>${esc(S.config.name)}${S.me ? ' · ' + esc(nameOf(S.me)) : ''}</small></div></div>${who}</div>`;
}

// ---------- render ----------
function render() {
  const app = document.getElementById('app');
  if (S.phase === 'loading') { app.innerHTML = `<div class="wrap">${topHTML()}<div class="skel">Đang tải…</div></div>`; return; }
  if (S.phase === 'login') { app.innerHTML = loginHTML(); bindAuthForms(); return; }
  if (S.phase === 'setup') { app.innerHTML = setupHTML(); bindAuthForms(); return; }
  if (S.phase === 'inactive') {
    app.innerHTML = `<div class="wrap">${topHTML()}<div class="card"><h3>Tài khoản chưa được kích hoạt</h3><p class="ink2" style="margin:0">Tài khoản ${esc(S.email)} chưa có trong danh sách nhân viên hoặc đã bị tạm khóa. Vui lòng liên hệ quản lý.</p></div></div>`;
    bindCommon(); return;
  }
  if (S.view === 'kiosk' && S.isAdmin) { app.innerHTML = kioskHTML() + navHTML(); bindView(); tick(); return; }
  let body;
  if (S.view === 'live' && S.isAdmin) body = liveHTML();
  else if (S.view === 'report' && S.isAdmin) body = reportHTML();
  else if (S.view === 'staff' && S.isAdmin) body = staffHTML();
  else if (S.view === 'settings' && S.isAdmin) body = settingsHTML();
  else if (S.view === 'history') body = historyHTML();
  else body = homeHTML();
  const wide = ['live', 'report', 'staff'].includes(S.view) && S.isAdmin;
  const active = document.activeElement;
  if (active && active.closest && active.closest('#app form') && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return; // không vẽ lại khi đang gõ
  app.innerHTML = `<div class="wrap ${wide ? 'wide' : ''}">${topHTML()}${body}</div>${navHTML()}`;
  bindView();
  tick();
}

// ---------- đăng nhập / thiết lập ----------
function authShell(inner) {
  return `<div class="wrap" style="padding-top:40px">${topHTML()}<div class="card">${inner}</div>
  <p class="muted" style="text-align:center;font-size:12.5px">Mẹo: iPhone mở bằng Safari → Chia sẻ → <b>Thêm vào MH chính</b>; Android mở bằng Chrome → ⋮ → <b>Thêm vào màn hình chính</b>.</p></div>`;
}
function loginHTML() {
  return authShell(`<h3 style="font-size:18px">Đăng nhập</h3>
    <form id="loginForm">
      <label class="f">Email</label><input class="inp" type="email" name="email" autocomplete="username" required>
      <label class="f">Mật khẩu</label><input class="inp" type="password" name="password" autocomplete="current-password" required>
      <div id="authErr" style="color:var(--red);font-size:13px;min-height:18px;margin:10px 2px 0"></div>
      <button class="btn primary" style="width:100%;padding:12px;margin-top:8px" type="submit">Đăng nhập</button>
    </form>
    <button class="btn small" style="margin-top:12px" id="forgotBtn">Quên mật khẩu?</button>`);
}
function setupHTML() {
  return authShell(`<h3 style="font-size:18px">Thiết lập lần đầu</h3>
    <p class="ink2" style="margin:0 0 4px;font-size:14px">Tạo tài khoản <b>quản lý</b> đầu tiên. Bước này chỉ làm một lần; sau đó quản lý thêm tài khoản cho nhân viên trong app.</p>
    <form id="setupForm">
      <label class="f">Họ tên</label><input class="inp" name="name" required maxlength="60">
      <label class="f">Email</label><input class="inp" type="email" name="email" autocomplete="username" required>
      <label class="f">Mật khẩu (ít nhất 6 ký tự)</label><input class="inp" type="password" name="password" autocomplete="new-password" minlength="6" required>
      <div id="authErr" style="color:var(--red);font-size:13px;min-height:18px;margin:10px 2px 0"></div>
      <button class="btn primary" style="width:100%;padding:12px;margin-top:8px" type="submit">Tạo tài khoản quản lý</button>
    </form>`);
}
function authErr(e) {
  const c = e && e.code || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'Email hoặc mật khẩu không đúng.';
  if (c.includes('too-many-requests')) return 'Thử sai quá nhiều lần, vui lòng đợi vài phút.';
  if (c.includes('email-already-in-use')) return 'Email này đã có tài khoản.';
  if (c.includes('weak-password')) return 'Mật khẩu cần ít nhất 6 ký tự.';
  if (c.includes('invalid-email')) return 'Email không hợp lệ.';
  if (c.includes('network')) return 'Mất kết nối mạng.';
  return (e && e.message) || 'Có lỗi, thử lại.';
}
function bindAuthForms() {
  bindCommon();
  const lf = document.getElementById('loginForm');
  if (lf) lf.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(lf), btn = lf.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Đang đăng nhập…';
    try { await signInWithEmailAndPassword(auth, String(fd.get('email')).trim(), String(fd.get('password'))); }
    catch (err) { document.getElementById('authErr').textContent = authErr(err); btn.disabled = false; btn.textContent = 'Đăng nhập'; }
  });
  const fb = document.getElementById('forgotBtn');
  if (fb) fb.addEventListener('click', async () => {
    const email = (document.querySelector('#loginForm [name=email]').value || '').trim();
    if (!email) { document.getElementById('authErr').textContent = 'Nhập email trước, rồi bấm "Quên mật khẩu".'; return; }
    try { await sendPasswordResetEmail(auth, email); toast('Đã gửi email đặt lại mật khẩu (kiểm tra cả mục Spam).'); }
    catch (err) { document.getElementById('authErr').textContent = authErr(err); }
  });
  const sf = document.getElementById('setupForm');
  if (sf) sf.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(sf), btn = sf.querySelector('button[type=submit]');
    const name = String(fd.get('name')).trim(), email = String(fd.get('email')).trim();
    btn.disabled = true; btn.textContent = 'Đang tạo…';
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, String(fd.get('password')));
      const uid = cred.user.uid, now = Date.now();
      const b = writeBatch(fs);
      b.set(doc(fs, `admins/${uid}`), { createdAt: now });
      b.set(doc(fs, 'meta/bootstrap'), { by: uid, at: now });
      b.set(doc(fs, `users/${uid}`), { name, email, active: true, createdAt: now });
      await b.commit();
      location.reload();
    } catch (err) { document.getElementById('authErr').textContent = authErr(err); btn.disabled = false; btn.textContent = 'Tạo tài khoản quản lý'; }
  });
}

// ---------- màn hình nhân viên ----------
function homeHTML() {
  const d = S.today || { date: S.todayKey, sessions: [] };
  const st = dayStats(d);
  const p = S.presence;
  const forgot = p && p.status === 'in' && p.date && p.date !== S.todayKey;
  let h = '';
  h += `<div class="hero"><div class="date">${esc(_fLong.format(new Date()))}</div>
    <div class="clock mono" data-clock>--:--:--</div>
    <div class="worked"><div><div class="lbl">Thời gian làm thực tế hôm nay</div><div class="val mono" data-worked>${durClock(st.worked)}</div></div>
    <div>${st.open ? '<span class="pill green" style="background:rgba(91,211,154,.16);color:#7BE3B2"><span class="dot pulse"></span>Đang làm việc</span>' : (st.ss.length ? '<span class="pill gray" style="background:rgba(255,255,255,.1);color:#D5DED9">Đã ra về</span>' : '<span class="pill gray" style="background:rgba(255,255,255,.1);color:#D5DED9">Chưa check-in</span>')}</div></div></div>`;
  if (forgot) h += `<div class="notice amber">⚠️ Ngày ${esc(p.date.split('-').reverse().join('/'))} bạn chưa check-out. Ca đó sẽ ghi là <b>thiếu giờ ra</b> — báo quản lý nếu cần điều chỉnh.</div>`;
  const la = p && p.lastAction, lc = p && p.lastCheck;
  if (la && la.day === S.todayKey && !la.code && la.geo) {
    if (Date.now() - la.t < 15 * 60000) h += `<div class="notice green">📍 Vị trí hợp lệ — lượt ${la.kind === 'in' ? 'check-in' : 'check-out'} lúc ${hm(la.t)}, cách quán ${fmtDist(la.geo.d || 0)}.</div>`;
  } else if (la && la.day === S.todayKey && la.code) {
    if (lc && lc.key === la.key) {
      if (lc.ok) { if (Date.now() - la.t < 15 * 60000) h += `<div class="notice green">✅ Mã hợp lệ — lượt ${la.kind === 'in' ? 'check-in' : 'check-out'} lúc ${hm(la.t)} đã được xác thực.</div>`; }
      else h += `<div class="notice red"><div style="flex:1">❌ Mã của lượt ${la.kind === 'in' ? 'check-in' : 'check-out'} lúc ${hm(la.t)} <b>không khớp</b> (sai số hoặc mã đã hết hạn).<div style="margin-top:8px"><button class="btn small" data-retry="${la.kind}">Nhập lại mã</button></div></div></div>`;
    } else if (Date.now() - la.t < 6 * 3600000) {
      h += Date.now() - la.t < 20000
        ? `<div class="notice blue">⏳ Đang đối chiếu mã với màn hình chấm công…</div>`
        : `<div class="notice blue">🕒 Lượt chấm lúc ${hm(la.t)} đã lưu. Mã sẽ được đối chiếu khi màn hình mã đang bật.</div>`;
    }
  }
  h += st.open
    ? `<button class="bigbtn out" data-act="out" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Đang lưu…' : 'Check-out · Ra về'}</button>`
    : `<button class="bigbtn in" data-act="in" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Đang lưu…' : (st.ss.length ? 'Check-in lại · Quay lại làm' : 'Check-in · Vào làm')}</button>`;
  h += `<div class="card"><div class="grid2">
    <div class="stat"><div class="k">Giờ vào đầu tiên</div><div class="v mono">${hm(st.firstIn)}</div>${st.late ? `<span class="pill amber" style="margin-top:6px">Muộn ${st.late} phút</span>` : (st.firstIn ? '<span class="pill green" style="margin-top:6px">Đúng giờ</span>' : '')}</div>
    <div class="stat"><div class="k">Giờ ra gần nhất</div><div class="v mono">${st.open ? '—' : hm(st.lastOut)}</div>${st.early ? `<span class="pill amber" style="margin-top:6px">Về sớm ${st.early} phút</span>` : ''}</div>
  </div><p class="muted" style="margin:12px 0 0;font-size:13px">Ca làm: ${esc(S.config.start)} – ${esc(S.config.end)} · cho phép muộn ${Number(S.config.grace) || 0} phút${usesGps() ? ` · chấm công trong bán kính ${Number(S.config.radius) || 20} m quanh quán` : ''}</p></div>`;
  h += `<div class="card"><h3>Các lượt trong ngày</h3>`;
  if (!st.ss.length) h += `<p class="muted" style="margin:0">Chưa có lượt nào. Bấm <b>Check-in</b> khi bạn đến nơi làm việc.</p>`;
  st.ss.forEach((s, i) => {
    const len = s.out ? s.out - s.in : Date.now() - s.in;
    h += `<div class="sess"><div><div class="t mono">${hm(s.in)} → ${s.out ? hm(s.out) : '<span style="color:var(--green)">đang làm</span>'}</div>
      <div class="muted" style="font-size:12.5px">Lượt ${i + 1}</div></div>
      <div class="mono ink2" ${s.out ? '' : `data-since="${s.in}"`}>${s.out ? dur(len) : durClock(len)}</div></div>`;
  });
  h += `</div><p class="muted" style="font-size:12.5px;text-align:center;margin:6px 0">Ra ngoài giữa giờ thì check-out rồi check-in lại để chỉ tính thời gian thực tế có mặt.</p>`;
  if (S.isAdmin) h += `<p style="text-align:center"><a href="#history" class="muted" style="font-size:13px">Xem lịch sử chấm công của tôi</a></p>`;
  return h;
}

function historyHTML() {
  const H = S.history;
  let h = `<div class="card"><div class="row"><h3 style="margin:0">Lịch sử chấm công</h3>
    <input type="month" class="inp" style="width:auto;padding:7px 10px" id="histMonth" value="${H.month}"></div></div>`;
  if (H.loading || !H.rows) return h + `<div class="skel">Đang tải…</div>`;
  const rows = H.rows, tot = rows.reduce((a, r) => a + r.st.worked, 0);
  h += `<div class="card"><div class="grid2">
    <div class="stat"><div class="k">Ngày có chấm công</div><div class="v">${rows.length}</div></div>
    <div class="stat"><div class="k">Tổng giờ thực tế</div><div class="v mono">${dur(tot)}</div></div>
    <div class="stat"><div class="k">Số ngày đi muộn</div><div class="v">${rows.filter(r => r.st.late).length}</div></div>
    <div class="stat"><div class="k">Thiếu giờ ra</div><div class="v">${rows.filter(r => r.st.missingOut).length}</div></div></div></div>`;
  h += `<div class="card"><div class="tscroll"><table><thead><tr><th>Ngày</th><th>Vào</th><th>Ra</th><th>Thực tế</th><th></th></tr></thead><tbody>`;
  if (!rows.length) h += `<tr><td colspan="5" class="muted">Không có dữ liệu trong tháng này.</td></tr>`;
  rows.forEach(r => {
    h += `<tr><td>${esc(_fShort.format(new Date(r.d.date + 'T12:00:00+07:00')))}</td><td class="mono">${hm(r.st.firstIn)}</td><td class="mono">${r.st.open ? '—' : hm(r.st.lastOut)}</td><td class="mono">${dur(r.st.worked)}</td>
    <td>${r.st.missingOut ? '<span class="pill red">Thiếu giờ ra</span>' : r.st.late ? `<span class="pill amber">Muộn ${r.st.late}p</span>` : ''}</td></tr>`;
  });
  return h + `</tbody></table></div></div>`;
}
async function loadDays(uid, ym) {
  const { from, to } = monthRange(ym);
  const q = await getDocs(query(collection(fs, `att/${uid}/days`), where('date', '>=', from), where('date', '<=', to)));
  return q.docs.map(x => x.data()).filter(d => (d.sessions || []).length);
}
async function loadHistory() {
  const H = S.history; H.loading = true; render();
  try { H.rows = (await loadDays(S.me, H.month)).sort((a, b) => b.date.localeCompare(a.date)).map(d => ({ d, st: dayStats(d) })); }
  catch (e) { H.rows = []; toast('Không tải được lịch sử', true); }
  H.loading = false; render();
}

// ---------- quản lý: trực tiếp ----------
function liveHTML() {
  if (!S.attLoaded || !S.usersLoaded) return `<div class="skel">Đang tải…</div>`;
  const now = Date.now(), tk = S.todayKey, startG = parseHM(S.config.start) + (Number(S.config.grace) || 0);
  const attById = Object.fromEntries(S.att.map(a => [a.id, a]));
  const ids = new Set([...S.users.filter(u => u.active).map(u => u.id), ...S.att.filter(a => a.date === tk).map(a => a.id)]);
  const list = [...ids].map(id => {
    const a = attById[id] || { id };
    const todayRec = a.date === tk, inNow = todayRec && a.status === 'in';
    const late = todayRec && a.firstIn && minOfDay(a.firstIn) > startG ? minOfDay(a.firstIn) - parseHM(S.config.start) : 0;
    return { id, a, todayRec, inNow, late, forgot: a.status === 'in' && !todayRec };
  });
  const nIn = list.filter(x => x.inNow).length, nOut = list.filter(x => x.todayRec && !x.inNow).length, nNone = list.filter(x => !x.todayRec).length, nLate = list.filter(x => x.late).length;
  let h = '';
  if (usesGps() && !S.config.loc) h += `<div class="notice amber">Chưa cài vị trí quán. Vào tab <b>Cài đặt</b> để nhập vị trí — nhân viên chỉ chấm công được khi ở trong bán kính quanh vị trí này.</div>`;
  if (usesCode() && !S.secret) h += `<div class="notice amber">Chưa có màn hình mã. Vào tab <b>Màn hình mã</b> để tạo mã và bật trên máy tính bảng/TV tại nơi làm việc — nhân viên cần mã này để chấm công.</div>`;
  h += `<div class="card"><div class="grid2" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat"><div class="k">Đang làm việc</div><div class="v" style="color:var(--green)">${nIn}</div></div>
    <div class="stat"><div class="k">Đã về</div><div class="v">${nOut}</div></div>
    <div class="stat"><div class="k">Đi muộn</div><div class="v" style="color:var(--amber)">${nLate}</div></div>
    <div class="stat"><div class="k">Chưa chấm</div><div class="v">${nNone}</div></div></div>
    <p class="muted" style="margin:10px 0 0;font-size:12.5px">Cập nhật theo thời gian thực.</p></div>`;
  const order = x => x.inNow ? 0 : x.todayRec ? 1 : 2;
  list.sort((x, y) => order(x) - order(y) || nameOf(x.id).localeCompare(nameOf(y.id), 'vi'));
  h += `<div class="card"><h3>Hôm nay · ${esc(_fShort.format(new Date()))}</h3><div class="tscroll"><table><thead><tr><th>Nhân viên</th><th>Trạng thái</th><th>Vào đầu tiên</th><th>Thời gian thực tế</th><th>Xác thực</th></tr></thead><tbody>`;
  if (!list.length) h += `<tr><td colspan="5" class="muted">Chưa có nhân viên. Vào tab <b>Nhân viên</b> để thêm tài khoản.</td></tr>`;
  list.forEach(({ id, a, todayRec, inNow, late, forgot }) => {
    const n = nameOf(id);
    const status = inNow ? `<span class="pill green"><span class="dot pulse"></span>Đang làm từ ${hm(a.since)}</span>`
      : todayRec ? `<span class="pill gray">Đã về lúc ${hm(a.since)}</span>`
      : forgot ? `<span class="pill red">Quên check-out ${esc((a.date || '').slice(5).split('-').reverse().join('/'))}</span>`
      : `<span class="pill gray">Chưa check-in</span>`;
    const worked = todayRec ? (a.todayClosedMs || 0) + (inNow ? now - a.since : 0) : 0;
    const la = a.lastAction, lc = a.lastCheck;
    const ver = !todayRec || !la ? '' : (!la.code && la.geo) ? `<span class="pill green">📍 ${fmtDist(la.geo.d || 0)}</span>` : (lc && lc.key === la.key ? (lc.ok ? '<span class="pill green">✓ Hợp lệ</span>' : '<span class="pill red">✗ Sai mã</span>') : '<span class="pill blue">Đang đối chiếu</span>');
    h += `<tr><td><div class="emp"><div class="av ${inNow ? 'in' : ''}">${esc(initials(n))}</div><b>${esc(n)}</b></div></td>
      <td>${status}</td><td class="mono">${todayRec ? hm(a.firstIn) : '—'} ${late ? `<span class="pill amber">+${late}p</span>` : ''}</td>
      <td class="mono" ${inNow ? `data-live-base="${a.todayClosedMs || 0}" data-live-since="${a.since}"` : ''}>${todayRec ? durClock(worked) : '—'}</td><td>${ver}</td></tr>`;
  });
  return h + `</tbody></table></div></div>`;
}

// ---------- quản lý: báo cáo ----------
function reportHTML() {
  const R = S.report;
  let h = `<div class="card"><div class="row" style="flex-wrap:wrap"><h3 style="margin:0">Báo cáo chấm công theo tháng</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="month" class="inp" style="width:auto;padding:7px 10px" id="repMonth" value="${R.month}">
    <button class="btn" id="repCopy" ${R.data ? '' : 'disabled'}>Sao chép CSV</button></div></div>
    <p class="muted" style="margin:10px 0 0;font-size:12.5px">Giờ thực tế = tổng các lượt có đủ giờ vào và giờ ra. Cột "Không hợp lệ" kiểm tra lại vị trí GPS (hoặc mã) của từng lượt chấm.</p></div>`;
  if (R.loading || !R.data) return h + `<div class="skel">${R.loading ? 'Đang tổng hợp…' : ''}</div>`;
  if (!R.data.length) return h + `<div class="card muted">Không có dữ liệu chấm công trong tháng này.</div>`;
  h += `<div class="card"><h3>Tổng hợp theo nhân viên</h3><div class="tscroll"><table><thead><tr><th>Nhân viên</th><th>Số ngày</th><th>Tổng giờ</th><th>TB/ngày</th><th>Đi muộn</th><th>Về sớm</th><th>Thiếu giờ ra</th><th>Không hợp lệ</th><th></th></tr></thead><tbody>`;
  R.data.forEach(e => {
    const days = e.rows.length, tot = e.rows.reduce((a, r) => a + r.st.worked, 0);
    const late = e.rows.filter(r => r.st.late).length, early = e.rows.filter(r => r.st.early).length, miss = e.rows.filter(r => r.st.missingOut).length;
    const bad = e.rows.reduce((a, r) => a + (r.v ? r.v.bad : 0), 0), n = nameOf(e.id);
    h += `<tr><td><div class="emp"><div class="av">${esc(initials(n))}</div><b>${esc(n)}</b></div></td><td>${days}</td><td class="mono">${dur(tot)}</td><td class="mono">${days ? dur(tot / days) : '—'}</td>
      <td>${late ? `<span class="pill amber">${late}</span>` : '0'}</td><td>${early ? `<span class="pill amber">${early}</span>` : '0'}</td><td>${miss ? `<span class="pill red">${miss}</span>` : '0'}</td>
      <td>${bad ? `<span class="pill red">${bad} lượt</span>` : '<span class="pill green">0</span>'}</td>
      <td><button class="btn small" data-open="${esc(e.id)}">${R.open === e.id ? 'Ẩn' : 'Chi tiết'}</button></td></tr>`;
    if (R.open === e.id) {
      h += `<tr><td colspan="9" style="background:#FAF9F5"><table><thead><tr><th>Ngày</th><th>Vào</th><th>Ra</th><th>Số lượt</th><th>Thực tế</th><th>Ghi chú</th></tr></thead><tbody>`;
      e.rows.forEach(r => {
        const notes = [];
        if (r.st.late) notes.push(`<span class="pill amber">Muộn ${r.st.late}p</span>`);
        if (r.st.early) notes.push(`<span class="pill amber">Sớm ${r.st.early}p</span>`);
        if (r.st.missingOut) notes.push('<span class="pill red">Thiếu giờ ra</span>');
        if (r.v && r.v.bad) notes.push(`<span class="pill red">${r.v.bad} lượt không hợp lệ</span>`);
        if (r.st.ss[0] && r.st.ss[0].inGeo) notes.push(`<span class="pill gray">📍 ${fmtDist(r.st.ss[0].inGeo.d || 0)}</span>`);
        h += `<tr><td>${esc(_fShort.format(new Date(r.d.date + 'T12:00:00+07:00')))}</td><td class="mono">${hm(r.st.firstIn)}</td><td class="mono">${r.st.open ? 'đang làm' : hm(r.st.lastOut)}</td><td>${r.st.ss.length}</td><td class="mono">${dur(r.st.worked)}</td><td>${notes.join(' ')}</td></tr>`;
      });
      h += `</tbody></table></td></tr>`;
    }
  });
  return h + `</tbody></table></div></div>`;
}
async function loadReport() {
  const R = S.report; R.loading = true; R.data = null; render();
  try {
    const ids = [...new Set([...S.users.map(u => u.id), ...S.att.map(a => a.id)])];
    const out = [];
    for (const id of ids) {
      const rows = (await loadDays(id, R.month)).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({ d, st: dayStats(d), v: verifyDay(d) }));
      if (rows.length) out.push({ id, rows });
    }
    out.sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id), 'vi'));
    R.data = out;
  } catch (e) { R.data = []; toast('Không tải được báo cáo', true); }
  R.loading = false; render();
}
function reportCSV() {
  const lines = [['Nhân viên', 'Email', 'Ngày', 'Giờ vào', 'Giờ ra', 'Số lượt', 'Giờ thực tế', 'Đi muộn (phút)', 'Về sớm (phút)', 'Thiếu giờ ra', 'Lượt không hợp lệ', 'Khoảng cách lúc vào (m)']];
  (S.report.data || []).forEach(e => e.rows.forEach(r => lines.push([
    nameOf(e.id), userOf(e.id)?.email || '', r.d.date, hm(r.st.firstIn), r.st.open ? '' : hm(r.st.lastOut), r.st.ss.length, hours(r.st.worked).replace('.', ','),
    r.st.late, r.st.early, r.st.missingOut ? 'Có' : '', r.v ? r.v.bad : '', r.st.ss[0] && r.st.ss[0].inGeo ? r.st.ss[0].inGeo.d : '',
  ])));
  return '﻿' + lines.map(l => l.map(c => { const s = String(c ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
}
function dayStats(d, now = Date.now()) {
  const cfg = S.config, ss = (d && d.sessions) || [];
  const isToday = d && d.date === dayKey(now);
  let worked = 0, open = false, missingOut = false, lastOut = null;
  ss.forEach(s => {
    if (s.out) { worked += s.out - s.in; lastOut = s.out; }
    else if (isToday) { open = true; worked += now - s.in; }
    else missingOut = true;
  });
  const firstIn = ss[0] ? ss[0].in : null;
  const st = parseHM(cfg.start), en = parseHM(cfg.end), grace = Number(cfg.grace) || 0;
  const late = firstIn && minOfDay(firstIn) > st + grace ? minOfDay(firstIn) - st : 0;
  const early = !open && lastOut && minOfDay(lastOut) < en ? en - minOfDay(lastOut) : 0;
  return { ss, worked, open, missingOut, firstIn, lastOut, late, early };
}
function verifyOne(code, geo, t) {
  if (code) return S.secret ? verifyCode(S.secret, code, t) : true;
  if (geo) return geoOk(geo);
  return false;
}
function verifyDay(d) {
  let bad = 0, total = 0;
  (d.sessions || []).forEach(s => {
    total++; if (!verifyOne(s.inCode, s.inGeo, s.in)) bad++;
    if (s.out) { total++; if (!verifyOne(s.outCode, s.outGeo, s.out)) bad++; }
  });
  return { bad, total };
}

// ---------- quản lý: nhân viên ----------
function staffHTML() {
  if (!S.usersLoaded) return `<div class="skel">Đang tải…</div>`;
  const list = [...S.users].sort((a, b) => (b.active === true) - (a.active === true) || (a.name || '').localeCompare(b.name || '', 'vi'));
  let h = `<div class="split"><form class="card" id="addUserForm"><h3>Thêm nhân viên</h3>
    <label class="f">Họ tên</label><input class="inp" name="name" required maxlength="60" placeholder="Nguyễn Văn A">
    <label class="f">Email đăng nhập</label><input class="inp" type="email" name="email" required placeholder="ten@gmail.com">
    <label class="f">Mật khẩu ban đầu (ít nhất 6 ký tự)</label><input class="inp" name="password" minlength="6" required autocomplete="new-password">
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">Gửi email + mật khẩu này cho nhân viên. Họ có thể đổi mật khẩu bằng nút "Quên mật khẩu" ở màn hình đăng nhập.</p>
    <div id="addErr" style="color:var(--red);font-size:13px;min-height:18px;margin:8px 2px 0"></div>
    <button class="btn primary" style="width:100%;padding:12px;margin-top:6px" type="submit">Tạo tài khoản</button></form>
    <div class="card"><h3>Danh sách (${list.filter(u => u.active).length} đang hoạt động)</h3><div class="tscroll"><table><thead><tr><th>Nhân viên</th><th>Trạng thái</th><th></th></tr></thead><tbody>`;
  if (!list.length) h += `<tr><td colspan="3" class="muted">Chưa có nhân viên.</td></tr>`;
  list.forEach(u => {
    const admin = u.id === S.me;
    h += `<tr><td><div class="emp"><div class="av">${esc(initials(u.name))}</div><div><b>${esc(u.name || '—')}</b><div class="muted" style="font-size:12px">${esc(u.email || '')}</div></div></div></td>
      <td>${u.active ? '<span class="pill green">Hoạt động</span>' : '<span class="pill gray">Đã khóa</span>'}</td>
      <td style="white-space:nowrap">${admin ? '<span class="pill blue">Bạn</span>' : `<button class="btn small" data-toggle="${esc(u.id)}">${u.active ? 'Khóa' : 'Mở khóa'}</button>`}
      ${u.email ? `<button class="btn small" data-reset="${esc(u.email)}">Gửi đặt lại MK</button>` : ''}</td></tr>`;
  });
  return h + `</tbody></table></div></div></div>`;
}
async function addUser(form) {
  const fd = new FormData(form), btn = form.querySelector('button[type=submit]'), err = document.getElementById('addErr');
  const name = String(fd.get('name')).trim(), email = String(fd.get('email')).trim().toLowerCase(), pw = String(fd.get('password'));
  btn.disabled = true; btn.textContent = 'Đang tạo…'; err.textContent = '';
  try {
    const sa = secondaryAuth();
    const cred = await createUserWithEmailAndPassword(sa, email, pw);
    const uid = cred.user.uid;
    await signOut(sa);
    await setDoc(doc(fs, `users/${uid}`), { name, email, active: true, createdAt: Date.now() });
    form.reset(); toast(`Đã tạo tài khoản cho ${name}`);
  } catch (e) { err.textContent = authErr(e); }
  btn.disabled = false; btn.textContent = 'Tạo tài khoản';
}

// ---------- quản lý: màn hình mã ----------
function kioskHTML() {
  if (!S.secretLoaded) return `<div class="kiosk"><div class="office">Đang tải…</div></div>`;
  if (!S.secret) return `<div class="kiosk"><div class="office">${esc(S.config.name)}</div>
    <h2 style="font-size:28px;margin:14px 0 8px">Chưa có mã bí mật</h2>
    <p style="color:#B9C7BF;max-width:460px">Tạo một lần. Sau đó mở trang này trên máy tính bảng hoặc TV đặt tại nơi làm việc — màn hình hiện mã 6 số đổi mỗi 30 giây để nhân viên nhập khi chấm công.</p>
    <button class="btn" style="margin-top:14px;padding:12px 20px" id="mkSecret">Tạo mã bí mật</button></div>`;
  const tk = S.todayKey;
  const feed = S.att.filter(a => a.lastAction && a.lastAction.day === tk).sort((a, b) => b.lastAction.t - a.lastAction.t).slice(0, 6);
  return `<div class="kiosk"><div class="office">${esc(S.config.name)} · Mã chấm công</div>
    <div class="code mono" data-kcode>------</div>
    <div class="bar"><i data-kbar style="width:100%"></i></div>
    <div style="color:#B9C7BF" class="mono" data-kclock></div>
    <p style="color:#D5DED9;margin-top:18px;font-size:17px">Mở app <b>Chấm công</b> → bấm Check-in / Check-out → nhập mã trên</p>
    <div class="feed">${feed.map(a => {
      const la = a.lastAction, lc = a.lastCheck, ok = lc && lc.key === la.key ? (lc.ok ? '✅' : '❌') : '⏳';
      return `<div class="it"><span>${ok} <b>${esc(nameOf(a.id))}</b> ${la.kind === 'in' ? 'check-in' : 'check-out'}</span><span class="mono">${hm(la.t)}</span></div>`;
    }).join('')}</div></div>`;
}
async function makeSecret() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  try { await setDoc(doc(fs, 'secure/kiosk'), { secret: bytesToHex(b), createdAt: Date.now() }); toast('Đã tạo mã bí mật'); }
  catch (e) { toast('Không tạo được mã bí mật', true); }
}

// ---------- quản lý: cài đặt ----------
function settingsHTML() {
  const c = S.config;
  return `<form class="card" id="cfgForm"><h3>Cài đặt</h3>
    <label class="f">Tên hiển thị</label><input class="inp" name="name" value="${esc(c.name)}" maxlength="60" required>
    <div class="grid2"><div><label class="f">Giờ bắt đầu</label><input class="inp" type="time" name="start" value="${esc(c.start)}" required></div>
    <div><label class="f">Giờ kết thúc</label><input class="inp" type="time" name="end" value="${esc(c.end)}" required></div></div>
    <label class="f">Cho phép đi muộn (phút)</label><input class="inp" type="number" name="grace" min="0" max="120" value="${Number(c.grace) || 0}">
    <label class="f">Cách xác nhận có mặt</label>
    <select class="inp" name="method">
      <option value="gps" ${method() === 'gps' ? 'selected' : ''}>Định vị GPS (không cần mã)</option>
      <option value="both" ${method() === 'both' ? 'selected' : ''}>GPS + mã 6 số trên màn hình (chặt nhất)</option>
      <option value="code" ${method() === 'code' ? 'selected' : ''}>Chỉ mã 6 số trên màn hình</option>
    </select>
    <label class="f">Vị trí quán (dán link Google Maps hoặc toạ độ "vĩ độ, kinh độ")</label>
    <input class="inp" name="loc" id="locIn" value="${c.loc ? c.loc.lat + ', ' + c.loc.lng : ''}" placeholder="21.30896, 105.60412">
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
      <button type="button" class="btn small" id="locHere">📍 Lấy vị trí tôi đang đứng</button>
      ${c.loc ? `<a class="muted" style="font-size:13px" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${c.loc.lat},${c.loc.lng}">Xem trên Google Maps</a>` : ''}
    </div>
    <label class="f">Bán kính cho phép (mét)</label><input class="inp" type="number" name="radius" min="10" max="1000" value="${Number(c.radius) || 20}">
    <p class="muted" style="font-size:12.5px;margin:6px 0 0">GPS điện thoại trong nhà thường lệch 10–40 m; app cộng thêm tối đa 30 m theo sai số GPS. Nếu nhân viên hay bị báo "chưa ở quán" dù đang ở quán, hãy tăng bán kính lên 50 m.</p>
    <button class="btn primary" style="margin-top:16px;width:100%;padding:12px" type="submit">Lưu cài đặt</button></form>
    <div class="card"><h3>Hướng dẫn triển khai</h3><ol class="ink2" style="margin:0;padding-left:20px;font-size:14px">
      <li style="margin-bottom:6px">Chế độ GPS: nhập vị trí quán ở trên (hoặc đứng tại quán bấm "Lấy vị trí tôi đang đứng"). Nếu dùng mã: mở tab <b>Màn hình mã</b> trên máy tính bảng/TV tại quán.</li>
      <li style="margin-bottom:6px">Vào tab <b>Nhân viên</b> tạo tài khoản cho từng người, gửi họ email + mật khẩu và đường link app.</li>
      <li style="margin-bottom:6px">Nhân viên mở link trên điện thoại → iPhone: Safari → Chia sẻ → <b>Thêm vào MH chính</b>; Android: Chrome → ⋮ → <b>Thêm vào màn hình chính</b>.</li>
      <li>Mỗi lần đến/về, nhân viên bấm Check-in/Check-out; app kiểm tra vị trí (và mã nếu bật).</li></ol></div>`;
}

// ---------- gắn sự kiện ----------
function bindCommon() {
  document.querySelectorAll('[data-logout]').forEach(b => b.onclick = () => signOut(auth));
}
function bindView() {
  bindCommon();
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => startCheck(b.dataset.act, false));
  document.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => startCheck(b.dataset.retry, true));
  const hmEl = document.getElementById('histMonth');
  if (hmEl) { hmEl.onchange = () => { S.history.month = hmEl.value || monthNow(); loadHistory(); }; if (!S.history.rows && !S.history.loading) loadHistory(); }
  const rm = document.getElementById('repMonth');
  if (rm) { rm.onchange = () => { S.report.month = rm.value || monthNow(); loadReport(); }; if (!S.report.data && !S.report.loading && S.attLoaded && S.usersLoaded) loadReport(); }
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { S.report.open = S.report.open === b.dataset.open ? null : b.dataset.open; render(); });
  const cp = document.getElementById('repCopy');
  if (cp) cp.onclick = async () => {
    const csv = reportCSV();
    try { await navigator.clipboard.writeText(csv.replace(/^﻿/, '')); toast('Đã sao chép CSV — dán vào Excel/Google Sheets'); }
    catch { showCSV(csv); }
  };
  const mk = document.getElementById('mkSecret'); if (mk) mk.onclick = makeSecret;
  const f = document.getElementById('cfgForm');
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(f);
    const locText = String(fd.get('loc') || '').trim();
    const loc = locText ? parseLoc(locText) : null;
    if (locText && !loc) { toast('Không đọc được vị trí. Hãy dán toạ độ dạng "21.30896, 105.60412" hoặc link Google Maps đầy đủ.', true); return; }
    const m = String(fd.get('method') || 'gps');
    if (m !== 'code' && !loc) { toast('Chế độ GPS cần nhập vị trí quán.', true); return; }
    const cfg = { name: String(fd.get('name')).trim() || 'WASU', start: fd.get('start'), end: fd.get('end'), grace: Math.max(0, Math.min(120, Number(fd.get('grace')) || 0)),
      method: m, loc, radius: Math.max(10, Math.min(1000, Number(fd.get('radius')) || 20)) };
    try { await setDoc(doc(fs, 'config/office'), cfg); document.activeElement?.blur(); toast('Đã lưu cài đặt'); } catch { toast('Không lưu được cài đặt', true); }
  };
  const lh = document.getElementById('locHere');
  if (lh) lh.onclick = async () => {
    lh.disabled = true; lh.textContent = 'Đang lấy vị trí…';
    try { const g = await getPosition(); document.getElementById('locIn').value = `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}`; toast(`Đã lấy vị trí (sai số ±${g.acc} m). Bấm "Lưu cài đặt" để áp dụng.`); }
    catch { toast('Không lấy được vị trí. Hãy cho phép quyền vị trí cho trang này.', true); }
    lh.disabled = false; lh.textContent = '📍 Lấy vị trí tôi đang đứng';
  };
  const af = document.getElementById('addUserForm');
  if (af) af.onsubmit = e => { e.preventDefault(); addUser(af); };
  document.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    const u = userOf(b.dataset.toggle); if (!u) return;
    try { await updateDoc(doc(fs, `users/${u.id}`), { active: !u.active }); toast(u.active ? `Đã khóa ${u.name}` : `Đã mở khóa ${u.name}`); }
    catch { toast('Không cập nhật được', true); }
  });
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
    try { await sendPasswordResetEmail(auth, b.dataset.reset); toast(`Đã gửi email đặt lại mật khẩu tới ${b.dataset.reset}`); }
    catch (e) { toast(authErr(e), true); }
  });
}
function showCSV(csv) {
  document.getElementById('modal').innerHTML = `<div class="modal-bg" data-close><div class="sheet">
    <div class="row"><b>Dữ liệu CSV</b><button class="btn small" data-close-btn>Đóng</button></div>
    <p class="muted" style="font-size:13px">Chọn toàn bộ và sao chép, rồi dán vào Excel hoặc Google Sheets.</p>
    <textarea class="inp mono" style="height:260px;font-size:12px" readonly>${esc(csv)}</textarea></div></div>`;
  bindModalClose();
}

// ---------- đồng hồ realtime ----------
function tick() {
  if (S.phase !== 'app') return;
  const now = Date.now(), k = dayKey(now);
  if (k !== S.todayKey) { S.todayKey = k; subscribeToday(); }
  document.querySelectorAll('[data-clock]').forEach(el => el.textContent = hms(now));
  const w = document.querySelector('[data-worked]');
  if (w && S.today) w.textContent = durClock(dayStats(S.today, now).worked);
  document.querySelectorAll('[data-since]').forEach(el => el.textContent = durClock(now - Number(el.dataset.since)));
  document.querySelectorAll('[data-live-since]').forEach(el => el.textContent = durClock(Number(el.dataset.liveBase) + now - Number(el.dataset.liveSince)));
  const kc = document.querySelector('[data-kcode]');
  if (kc && S.secret) {
    const win = Math.floor(now / WINDOW_MS);
    if (win !== lastWin || kc.textContent === '------') { lastWin = win; const c = codeFor(S.secret, win); kc.textContent = c.slice(0, 3) + ' ' + c.slice(3); }
    const left = WINDOW_MS - (now % WINDOW_MS);
    const bar = document.querySelector('[data-kbar]'); if (bar) bar.style.width = (left / WINDOW_MS * 100) + '%';
    const kcl = document.querySelector('[data-kclock]'); if (kcl) kcl.textContent = `${hms(now)} · mã mới sau ${Math.ceil(left / 1000)} giây`;
  }
  const p = S.presence;
  if (p && p.lastAction && (!p.lastCheck || p.lastCheck.key !== p.lastAction.key) && S.view === 'home') {
    if (now - p.lastAction.t > 20000 && !rendered20.has(p.lastAction.key)) { rendered20.add(p.lastAction.key); setTimeout(render, 0); }
  }
}
setInterval(tick, 1000);
render();
