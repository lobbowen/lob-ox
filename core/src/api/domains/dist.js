'use strict';

const { isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');

function owns(pathname) {
  return pathname.startsWith('/dist/');
}

function probeTargetError(origin, sup) {
  let u = null;
  try { u = new URL(origin); } catch { return 'origin 不是合法 URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'origin 必须以 http(s):// 开头';
  if (u.username || u.password) return 'origin 不允许携带用户名或密码';
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'origin 缺少主机名';

  let configured = [];
  try {
    configured = (sup && sup.dist && typeof sup.dist._registryOrigins === 'function')
      ? (sup.dist._registryOrigins() || []) : [];
  } catch { configured = []; }
  for (const c of configured) {
    try { if (new URL(String(c)).hostname.toLowerCase().replace(/^\[|\]$/g, '') === host) return null; } catch {}
  }

  const deny = '安全策略：探测目标仅允许公网地址（已配置的镜像源不在此限）';
  if (host.includes(':')) return deny;
  if (!host.includes('.')) return deny;
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return deny;
  if (isLoopbackAddress(host) || isPrivateIpv4(host)) return deny;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const o = Number(v4[1]), t = Number(v4[2]);
    if (o === 0 || o >= 224) return deny;
    if (o === 169 && t === 254) return deny;
    if (o === 100 && t >= 64 && t <= 127) return deny;
  }
  return null;
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/dist/registry') {
      Promise.resolve(sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/set') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 8192, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        Promise.resolve(sup.dist.setRegistryConfig(j)).then((r) => {
          const msg = r && r.error ? String(r.error) : '';
          send(msg ? 400 : 200, msg ? { ok: false, ...r } : { ok: true, ...r });
        }).catch((e) => send(500, { ok: false, error: e.message }));
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/refresh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      sup.dist.selectRegistry(true).then(() => sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/probe') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return collectBody(req, res, 4096, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        const origin = String(j.origin || '').trim();
        if (!/^https?:\/\//.test(origin)) return send(400, { ok: false, error: 'origin 必须以 http(s):// 开头' });
        const targetErr = probeTargetError(origin, sup);
        if (targetErr) return send(400, { ok: false, error: targetErr });
        Promise.resolve(sup.dist.probeOrigin(origin))
          .then((r) => send(200, { ok: true, ...r }))
          .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      });
    }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
