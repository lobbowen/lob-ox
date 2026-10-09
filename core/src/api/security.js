'use strict';

const crypto = require('node:crypto');

const { isPrivateIpv4 } = require('./identity');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalOrLanHost(h) {
  if (!h) return false;
  const s = String(h).toLowerCase();
  if (LOOPBACK_HOSTS.has(s)) return true;
  const bare = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (bare === '::1') return true;
  return isPrivateIpv4(bare);
}

function isShellOrigin(protocol, hostname) {
  const h = String(hostname || '').toLowerCase();
  if (protocol === 'tauri:') return h === 'localhost' || /(^|\.)tauri\.localhost$/.test(h);
  if (protocol === 'http:' || protocol === 'https:') return h === 'tauri.localhost';
  return false;
}

function normalizeHostname(h) {
  const s = String(h || '').toLowerCase();
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

function originAllowed(req, apiPort) {
  // Host 闸 fail-closed 防 DNS-rebinding：HTTP/1.1 起 Host 必发，缺失即拒（放行会与「无 Origin 放行」组合成两闸同时归零）。
  const host = req.headers.host;
  if (!host) return false;
  let hostname = '';
  {
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(host).trim());
    hostname = m ? m[1] : String(host).trim();
    if (!isLocalOrLanHost(hostname)) return false;
  }

  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    if (isShellOrigin(u.protocol, u.hostname)) return true;
    if (!isLocalOrLanHost(u.hostname)) return false;
    if (host && normalizeHostname(u.hostname) !== normalizeHostname(hostname)) return false;
    const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return port === String(apiPort);
  } catch {
    return false;
  }
}

// 常数时间字符串比较（防时序侧信道）。
function safeKeyEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requestHasAccessKey(req, key) {
  if (!key) return true;
  const ah = req.headers.authorization;
  if (typeof ah === 'string' && ah.startsWith('Bearer ') && safeKeyEqual(ah.slice(7), key)) return true;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('access_key');
    if (q && safeKeyEqual(q, key)) return true;
  } catch {}
  return false;
}

module.exports = { originAllowed, isLocalOrLanHost, isShellOrigin, requestHasAccessKey };
