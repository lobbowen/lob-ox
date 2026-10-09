'use strict';

const http = require('node:http');

const { API_DOMAINS } = require('../router-table');
const { collectBody } = require('./body');
const { serveStatic } = require('../static');
const { identify } = require('../identity');
const { originAllowed, requestHasAccessKey, isShellOrigin } = require('../security');
const browserExit = require('../../platform/os/browser');
const environmentExit = require('../../platform/os/environment');

function safeFail(res, err, where) {
  try {
    const body = JSON.stringify({ ok: false, error: (err && err.message) || String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    }
    try { res.end(body); } catch {}
  } catch {}
  try { console.error('[api] handler error (' + (where || '?') + '):', (err && err.stack) || err); } catch {}
}

function createServer(sup, deps) {
  const browser = (deps && deps.browser) || browserExit;
  const environment = (deps && deps.environment) || environmentExit;
  return http.createServer((req, res) => {
    const shellOrigin = (() => {
      const o = req.headers.origin;
      if (!o) return null;
      try {
        const u = new URL(o);
        return isShellOrigin(u.protocol, u.hostname) ? o : null;
      } catch {}
      return null;
    })();
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      const hdrs = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (shellOrigin) { hdrs['Access-Control-Allow-Origin'] = shellOrigin; hdrs['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'; hdrs['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'; }
      res.writeHead(code, hdrs);
      res.end(body);
    };

    const tokOf = (id) => {
      try { if (sup.tokenService && typeof sup.tokenService.get === 'function') return sup.tokenService.get(id) || ''; } catch {}
      return '';
    };

    const identity = identify(req);

    // apiAccessKey fail-closed：非回环必须带匹配 key，未配置 key 时同样拒绝（否则 0.0.0.0 零认证可驱动写 API）；回环与 OPTIONS 预检豁免。
    const accessKey = (sup && sup.config && sup.config.apiAccessKey) || null;
    if (!identity.loopback && req.method !== 'OPTIONS' && (!accessKey || !requestHasAccessKey(req, accessKey))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      const why = accessKey
        ? '需要访问密钥（apiAccessKey）：请求头 Authorization: Bearer <key> 或 ?access_key=<key>'
        : '未配置访问密钥（apiAccessKey）：非回环请求一律拒绝。请先设置访问密钥，或将 apiHost 收回 127.0.0.1';
      return res.end(JSON.stringify({ error: why }));
    }

    if (req.method === 'OPTIONS') {
      if (shellOrigin) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': shellOrigin,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Max-Age': '600',
        });
      } else {
        res.writeHead(204);
      }
      return res.end();
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(400, { error: 'bad request' });
    }

    let decodedPathname;
    try {
      decodedPathname = pathname.split('/').map((seg) => {
        try { return decodeURIComponent(seg); } catch { throw new Error('bad encoding'); }
      }).join('/');
    } catch (e) {
      return send(400, { error: 'bad request encoding' });
    }

    const ctx = { sup, req, res, pathname: decodedPathname, identity, send, collectBody, originAllowed, tokOf, browser, environment };

    for (const d of API_DOMAINS) {
      if (d.owns(pathname)) {
        try {
          const out = d.handle(ctx);
          if (out && typeof out.catch === 'function') out.catch((e) => safeFail(res, e, 'handler'));
        } catch (e) { safeFail(res, e, 'handler'); }
        return;
      }
    }

    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html' || pathname === '/supervisor.html') {
        return serveStatic(res, 'supervisor.html', shellOrigin);
      }
      const file = pathname.slice(1);
      if (file.startsWith('assets/') || file === 'dsh-logo.svg') {
        return serveStatic(res, file, shellOrigin);
      }
    }

    if (req.method === 'GET' || req.method === 'POST') {
      return send(404, { error: 'not found', path: pathname });
    }
    return send(405, { error: 'method not allowed' });
  });
}

module.exports = { createServer };
