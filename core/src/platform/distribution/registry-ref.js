'use strict';

const { isPrivateHostLiteral } = require('../../shared/ip');

const REDIRECT_MAX_HOPS = 3;

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 10000;

function normalizeBase(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
}

function hostViolation(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return '镜像源缺少主机名';
  if (isPrivateHostLiteral(h)) return '镜像源主机不得为回环/私网/链路本地/保留段字面量: ' + h;
  return null;
}

function parseRegistryBase(raw) {
  const base = normalizeBase(raw);
  const bad = (violation) => ({ ok: false, base, protocol: '', host: '', violation });
  if (!base) return bad('镜像源为空');
  if (/[\s]/.test(base)) return bad('镜像源不得含空白字符');
  let u;
  try { u = new URL(base); } catch { return bad('镜像源无法解析: ' + base); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return bad('镜像源必须是 http(s) 协议: ' + base);
  if (u.username || u.password) return bad('镜像源不得携带用户名或密码: ' + base);
  if (u.search) return bad('镜像源不得携带查询串: ' + base);
  if (u.hash) return bad('镜像源不得携带片段: ' + base);
  if (!u.hostname) return bad('镜像源缺少主机名: ' + base);
  return { ok: true, base, protocol: u.protocol.replace(/:$/, ''), host: u.hostname, violation: null };
}

function targetHostViolation(rawUrl, fromUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return '跳转目标无法解析'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '跳转目标协议非法: ' + u.protocol;
  if (u.username || u.password) return '跳转目标不得携带凭证';
  let from;
  try { from = new URL(String(fromUrl || '')); } catch { from = null; }
  if (from && from.hostname.toLowerCase() === u.hostname.toLowerCase()) return null;
  return hostViolation(u.hostname);
}

function registryPackagePath(pkg) {
  return encodeURIComponent(String(pkg || ''));
}

function registryUrl(base, ...segments) {
  const parsed = parseRegistryBase(base);
  if (!parsed.ok) return null;
  const tail = segments.filter((s) => s !== '' && s != null)
    .map((s) => String(s).replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean).join('/');
  return tail ? parsed.base + '/' + tail : parsed.base;
}

function registryEnvPair(base) {
  const parsed = parseRegistryBase(base);
  if (!parsed.ok) return { ok: false, violation: parsed.violation, base: null, env: null };
  return {
    ok: true, violation: null, base: parsed.base,
    env: { npm_config_registry: parsed.base, NPM_CONFIG_REGISTRY: parsed.base },
  };
}

async function readCapped(res, maxBytes) {
  const cl = Number(res.headers && res.headers.get('content-length')) || 0;
  if (cl > maxBytes) return null;
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength || value.length || 0;
    if (total > maxBytes) { try { await reader.cancel(); } catch {  } return null; }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return buf.toString('utf8');
}

async function fetchRegistry(startUrl, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : MAX_BODY_BYTES;
  const maxHops = Number.isFinite(o.maxHops) ? o.maxHops : REDIRECT_MAX_HOPS;
  let url = String(startUrl || '');
  const hops = [];
  const fail = (status, error) => ({ ok: false, status, json: null, error, url, hops });
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    } catch (e) {
      return fail(null, (e && (e.name === 'TimeoutError' ? '超时' : e.message)) || String(e));
    }
    hops.push({ url, status: res.status });
    if (res.status >= 300 && res.status < 400) {
      try { if (res.body) await res.body.cancel(); } catch {  }
      if (hop >= maxHops) return fail(res.status, '跳转次数超过上限');
      const loc = res.headers.get('location');
      if (!loc) return fail(res.status, '跳转缺少 Location');
      let next;
      try { next = new URL(loc, url).toString(); } catch { return fail(res.status, '跳转目标无法解析'); }
      const tv = targetHostViolation(next, url);
      url = next;
      if (tv) return fail(res.status, tv);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      try { if (res.body) await res.body.cancel(); } catch {  }
      return fail(res.status, 'HTTP ' + res.status);
    }
    if (o.expect === 'none') {
      try { if (res.body) await res.body.cancel(); } catch {  }
      return { ok: true, status: res.status, json: null, error: null, url, hops };
    }
    let text;
    try {
      text = await readCapped(res, maxBytes);
    } catch (e) {
      return fail(res.status, '读取响应体中断：' + ((e && e.message) || String(e)));
    }
    if (text === null) return fail(res.status, '响应体超过上限');
    if (o.expect !== 'json') return { ok: true, status: res.status, json: null, text, error: null, url, hops };
    try {
      return { ok: true, status: res.status, json: JSON.parse(text), error: null, url, hops };
    } catch {
      return fail(res.status, '响应不是合法 JSON');
    }
  }
}

module.exports = {
  normalizeBase,
  hostViolation,
  parseRegistryBase,
  targetHostViolation,
  registryEnvPair,
  registryPackagePath,
  registryUrl,
  fetchRegistry,
};
