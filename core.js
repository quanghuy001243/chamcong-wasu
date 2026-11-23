// ============ CRYPTO-START (SHA-256 / HMAC / mã 6 số) ============
const _K = (() => {
  const k = []; let n = 2;
  while (k.length < 64) {
    let p = true; for (let i = 2; i * i <= n; i++) if (n % i === 0) { p = false; break; }
    if (p) { const c = Math.cbrt(n); k.push(Math.floor((c - Math.floor(c)) * 4294967296) >>> 0); }
    n++;
  }
  return k;
})();
const _rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(bytes) {
  const l = bytes.length, total = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total); m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer), bits = l * 8;
  dv.setUint32(total - 4, bits >>> 0); dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const s0 = _rotr(w[j - 15], 7) ^ _rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = _rotr(w[j - 2], 17) ^ _rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let j = 0; j < 64; j++) {
      const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + _K[j] + w[j]) >>> 0;
      const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map(x => x >>> 0);
  }
  const out = new Uint8Array(32), odv = new DataView(out.buffer);
  h.forEach((x, i) => odv.setUint32(i * 4, x));
  return out;
}
const utf8 = s => new TextEncoder().encode(s);
const hexToBytes = hex => new Uint8Array((hex.match(/../g) || []).map(b => parseInt(b, 16)));
const bytesToHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
function hmac256(key, msg) {
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64); k.set(key);
  const ip = new Uint8Array(64 + msg.length), op = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
  ip.set(msg, 64); op.set(sha256(ip), 64);
  return sha256(op);
}
const WINDOW_MS = 30000;
function codeFor(secretHex, win) {
  const mac = hmac256(hexToBytes(secretHex), utf8('W' + win));
  const num = (((mac[0] & 0x7f) << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) % 1000000;
  return String(num).padStart(6, '0');
}
// Mã hợp lệ nếu khớp cửa sổ 30 giây quanh thời điểm chấm (cho phép trễ gõ ~90s, lệch đồng hồ ~60s)
function verifyCode(secretHex, code, t) {
  if (!secretHex || !/^\d{6}$/.test(String(code || ''))) return false;
  const w = Math.floor(t / WINDOW_MS);
  for (let d = -3; d <= 2; d++) if (codeFor(secretHex, w + d) === code) return true;
  return false;
}
// ============ CRYPTO-END ============

// ---------- thời gian (giờ Việt Nam) ----------
const TZ = 'Asia/Ho_Chi_Minh';
const _fD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const _fT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const _fTS = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const _fLong = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const _fShort = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
const dayKey = t => _fD.format(new Date(t));
const hm = t => t ? _fT.format(new Date(t)) : '—';
const hms = t => _fTS.format(new Date(t));
const minOfDay = t => { const [h, m] = _fT.format(new Date(t)).split(':').map(Number); return h * 60 + m; };
const parseHM = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const dur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const durClock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':'); };
const hours = ms => (Math.max(0, ms) / 3600000).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const initials = n => (n || '?').trim().split(/\s+/).slice(-2).map(x => x[0]).join('').toUpperCase();
const monthNow = () => dayKey(Date.now()).slice(0, 7);
function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}`, days: last };
}
