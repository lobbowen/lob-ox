'use strict';

function normalizeRemoteAddress(ra) {
  if (typeof ra !== 'string' || !ra) return null;
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ra);
  return m ? m[1] : ra.toLowerCase();
}

function isLoopbackAddress(ra) {
  const a = normalizeRemoteAddress(ra);
  if (!a) return false;
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

function isPrivateIpv4(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const o = Number(m[1]), t = Number(m[2]);
  if (o === 10) return true;
  if (o === 172 && t >= 16 && t <= 31) return true;
  if (o === 192 && t === 168) return true;
  return false;
}

function isPrivateHostLiteral(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h.includes(':')) return true;
  if (!h.includes('.')) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')
    || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (isLoopbackAddress(h) || isPrivateIpv4(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const o = Number(v4[1]), t = Number(v4[2]);
    if (o === 0 || o >= 224) return true;
    if (o === 127) return true;
    if (o === 169 && t === 254) return true;
    if (o === 100 && t >= 64 && t <= 127) return true;
  }
  return false;
}

module.exports = { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4, isPrivateHostLiteral };
