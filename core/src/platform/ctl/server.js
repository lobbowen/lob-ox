'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const isMethodAllowed = (allowMethods, method) =>
  Array.isArray(allowMethods) && typeof method === 'string' && allowMethods.includes(method);

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?$/i;

// R3 / 攻击链 A：ctl 面原先只有 content-type 与「Origin 存在时才校验回环」两道闸，
// 无任何身份凭据。而 router 的 ctl 白名单里有 addDirectProvider 与 activateProvider
// ——本机任意进程（任意 UID、无 Origin 头即可）可注入一个 baseUrl 任意的供应商
// 并让其 listen，之后内核会把请求（含 Authorization 头与请求体）转发到那个
// baseUrl，使内核成为带真实凭据的 SSRF 放大器。
// 修为机箱令牌鉴权：令牌由壳在 spawn daemon 时经环境变量 DSH_CTL_TOKEN 注入，
// 内核自身与壳驱动 ctl，面板从不直连。与 mgmt 端点同一范式。
const CTL_TOKEN_HEADER = 'x-lobox-ctl-token';

// 请求体上限，与 api/transport/body.js 的 collectBody 同一范式（1MB）。
// 单请求体不得无界增长——ctl 面在内核进程内，内存不受 api 侧同等保护。
const CTL_MAX_BODY_BYTES = 1 * 1024 * 1024;

function ctlTokenProblem(req) {
  const want = process.env.DSH_CTL_TOKEN;
  // 未配置令牌时不启用鉴权（单机无壳的开发态）。一旦配置，缺失或不匹配一律拒绝。
  if (!want) return null;
  const got = req.headers[CTL_TOKEN_HEADER];
  const gotStr = typeof got === 'string' ? got : '';
  if (!gotStr) return '缺少 ' + CTL_TOKEN_HEADER + ' 头';
  // 常量时间比较：避免逐字节短路泄露前缀匹配信息。
  const a = crypto.createHash('sha256').update(gotStr).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  if (!crypto.timingSafeEqual(a, b)) return 'ctl token 不匹配';
  return null;
}

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

    // 超限时先把 413 发出去并声明 Connection: close，再丢弃剩余请求体。
    // 原先 req.destroy() 无参立即拆 socket，客户端根本收不到 413（实测 ECONNRESET），
    // 且在 keepAliveTimeout=65s 的池上每超限一次就废掉一条连接。超限的请求本就不能复用，
    // 故先应答、再断链，而不是先断链。
    const sendTooLarge = () => {
      // 先标 Connection: close（res.end 之后再改 shouldKeepAlive 已不生效），再发 413，
      // 最后 pause+resume 丢弃剩余请求体：请求体已判废，但字节必须从 socket 读干净，
      // 否则 keep-alive 复用下一请求时会读到本请求的残字节。
      const payload = JSON.stringify({ ok: false, error: 'payload too large' });
      try { res.shouldKeepAlive = false; } catch {}
      try {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' });
        res.end(payload);
      } catch {}
      try { req.pause(); } catch {}
      try { req.resume(); } catch {}
    };

    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, pid: process.pid });
    }
    if (req.method !== 'POST' || req.url !== '/ctl') {
      return send(404, { ok: false, error: 'not found' });
    }
    // R3：先鉴权后来源闸。token 是身份凭据，content-type/Origin 是请求形态检查，
    // 二者不可互相替代——此前只做形态检查，导致无 Origin 的任意本地进程可直连。
    const tokBad = ctlTokenProblem(req);
    if (tokBad) {
      if (logger && logger.warn) logger.warn('[ctl] 令牌闸拒绝: ' + tokBad);
      try { req.resume(); } catch {}
      return send(401, { ok: false, error: 'ctl auth: ' + tokBad });
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
      if (body.length > CTL_MAX_BODY_BYTES) {
        settled = true;
        sendTooLarge();
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
        try { list = events.tailSince(afterSeq, args[1]); } catch (e2) { return send(200, { ok: false, error: (e2 && e2.message) || String(e2) }); }
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
