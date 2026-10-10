'use strict';

const http = require('node:http');

const isMethodAllowed = (allowMethods, method) =>
  Array.isArray(allowMethods) && typeof method === 'string' && allowMethods.includes(method);

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?$/i;

function ctlSourceProblem(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) return 'content-type 必须为 application/json';
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK_ORIGIN_RE.test(String(origin))) return 'Origin 非回环: ' + String(origin).slice(0, 80);
  return null;
}

function createCtlServer({ target, allowMethods, logger, events } = {}) {
  if (!Array.isArray(allowMethods) || allowMethods.length === 0) {
    throw new Error('createCtlServer: allowMethods（域方法白名单）必填且不能为空——白名单不可缺省');
  }
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      let body;
      try { body = JSON.stringify(obj); } catch { body = JSON.stringify({ ok: false, error: 'response not serializable' }); }
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, pid: process.pid });
    }
    if (req.method !== 'POST' || req.url !== '/ctl') {
      return send(404, { ok: false, error: 'not found' });
    }
    const srcBad = ctlSourceProblem(req);
    if (srcBad) {
      if (logger && logger.warn) logger.warn('[ctl] 来源闸拒绝: ' + srcBad);
      try { req.resume(); } catch {}
      return send(403, { ok: false, error: 'ctl source gate: ' + srcBad });
    }

    let body = '';
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      body += c;
      if (body.length > 1 << 20) {
        settled = true;
        send(413, { ok: false, error: 'payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      let m = null;
      try { m = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
      const method = m && typeof m.method === 'string' ? m.method : null;
      const args = Array.isArray(m && m.args) ? m.args : [];
      if (method === 'eventsTail' && isMethodAllowed(allowMethods, method)
          && events && typeof events.tailSince === 'function') {
        const afterSeq = Number(args[0]) || 0;
        let list = [];
        try { list = events.tailSince(afterSeq); } catch (e2) { return send(200, { ok: false, error: (e2 && e2.message) || String(e2) }); }
        return send(200, { ok: true, value: { seq: events.seq, events: list } });
      }
      
      if (!isMethodAllowed(allowMethods, method) || !target || typeof target[method] !== 'function') {
        if (logger && logger.warn && method) logger.warn('[ctl] 拒绝未登记方法: ' + method);
        return send(404, { ok: false, error: 'method not allowed: ' + method });
      }
      const started = Date.now();
      Promise.resolve()
        .then(() => target[method].apply(target, args))
        .then((value) => {
          if (logger && logger.debug) logger.debug('[ctl] ' + method + ' ok in ' + (Date.now() - started) + 'ms');
          send(200, { ok: true, value });
        })
        .catch((e) => {
          if (logger && logger.warn) logger.warn('[ctl] ' + method + ' error: ' + ((e && e.message) || e));
          send(200, { ok: false, error: (e && e.message) || String(e) });
        });
    });
    req.on('error', () => { try { res.end(); } catch {} });
  });
  server.on('error', (e) => { if (logger) logger.error('[ctl] server error: ' + e.message); });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;
  return server;
}

module.exports = { createCtlServer, isMethodAllowed, ctlSourceProblem };
