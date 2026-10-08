'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { isTrustedSource, tokenGateDecision, backoffGate, upstreamPath, redactLogPath, POLYFILL_SCRIPT } = require('./core');
const { createSession } = require('./session');
const { createTunnelHandler } = require('./tunnel');

// HTML polyfill 缓冲上限 2MB：超限放弃注入按流透传，绝不无界缓冲。
const HTML_INJECT_MAX_BYTES = 2 * 1024 * 1024;

function createGateLedger() {
  const map = new Map();
  return {
    waitMsFor(ip) {
      const e = map.get(ip);
      if (!e) return null;
      const w = backoffGate({ failCount: e.n, firstAt: e.first, now: Date.now() });
      if (w.waitMs === null && Date.now() - e.first >= 60000 && e.n >= 10) map.delete(ip);
      return w.waitMs;
    },
    recordFailure(ip) {
      const now = Date.now();
      const e = map.get(ip);
      if (!e || now - e.first >= 60000) map.set(ip, { n: 1, first: now });
      else e.n += 1;
    },
    clear(ip) { map.delete(ip); },
  };
}

function pipeWithHold(ur, res, clientReqPath, logger) {
  let clientGone = false;
  const log = (lv, msg) => { if (logger && logger[lv]) { try { logger[lv]('[relay] ' + msg); } catch {} } };
  ur.on('data', (c) => {
    if (clientGone) return;
    if (!res.write(c)) ur.pause();
  });
  res.on('drain', () => ur.resume());
  ur.on('end', () => {
    if (clientGone) log('info', 'relay: 上游响应自然结束（agent 完成，消息已落 DSH 会话）' + (clientReqLog ? ' ' + clientReqLog : ''));
    try { if (!clientGone) res.end(); } catch {}
  });
  ur.on('error', () => {
    try { if (!clientGone) res.end(); } catch {}
    try { ur.destroy(); } catch {}
  });
  res.on('close', () => {
    if (ur.readableEnded || ur.destroyed) return;
    clientGone = true;
    log('warn', 'relay: 客户端连接断开，保持上游连接直到响应结束（agent 不受影响）' + (clientReqLog ? ' ' + clientReqLog : ''));
  });
}

function buildForwardHeaders(req, authority, cookie) {
  const headers = { ...req.headers };
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers.host = authority;
  headers['accept-encoding'] = 'identity';
  if (headers.origin !== undefined) headers.origin = 'http://' + authority;
  if (headers.referer !== undefined) headers.referer = 'http://' + authority + '/';
  return headers;
}

function handleUpstream(ur, res, clientReqPath, onStatus, logger) {
  // RL-1：日志只用脱敏后的路径（剥离 ?token=），绝不把远程访问令牌写进日志。
  const clientReqLog = redactLogPath(clientReqPath);
  if (onStatus) onStatus(ur.statusCode);
  const h = { ...ur.headers };
  const isHtml = String(h['content-type'] || '').includes('text/html');
  if (isHtml) {
    h['cache-control'] = 'no-store';
    delete h['content-encoding'];
    delete h['content-length'];
    h['transfer-encoding'] = 'chunked';
  }
  res.writeHead(ur.statusCode || 502, h);
  if (!isHtml) { pipeWithHold(ur, res, clientReqPath, logger); return; }
  const chunks = [];
  let total = 0, passed = false, done = false;
  const log = (msg) => { if (logger && logger.warn) { try { logger.warn('[relay] ' + msg); } catch {} } };
  const switchToPassThrough = () => {
    passed = true;
    let acc = Buffer.concat(chunks);
    chunks.length = 0;
    if (acc.length) res.write(acc);
    acc = null;
    pipeWithHold(ur, res, clientReqPath, logger);
    if (ur.readableEnded) { try { res.end(); } catch {} }
  };
  ur.on('data', (c) => {
    if (passed) return;
    total += c.length;
    if (total <= HTML_INJECT_MAX_BYTES) { chunks.push(c); return; }
    log('HTML 超上限 ' + HTML_INJECT_MAX_BYTES + 'B（已收 ' + total + 'B），放弃 polyfill 注入按流透传 ' + (clientReqLog || ''));
    const selfForward = !ur.readableEnded;
    switchToPassThrough();
    if (selfForward) res.write(c);
  });
  ur.on('end', () => {
    if (done || passed) return;
    done = true;
    let body = Buffer.concat(chunks).toString('utf8');
    if (body.includes('</head>')) body = body.replace('</head>', POLYFILL_SCRIPT + '</head>');
    res.end(body);
  });
  ur.on('error', () => {
    if (done || passed) return;
    done = true;
    try { res.end(); } catch {}
  });
}

function createRelay(targetHost, targetPort, opts) {
  const o = opts || {};
  let token = o.token || '';
  const logger = o.logger || null;
  const authority = targetHost + ':' + targetPort;
  const gateSalt = crypto.randomBytes(16).toString('hex');

  const session = createSession({
    targetHost,
    targetPort,
    id: o.id || '',
    logger,
    events: o.events || null,
    dshTokenOf: o.dshTokenOf,
    dshToken: o.dshToken,
  });

  const gateLedger = createGateLedger();

  const server = http.createServer((req, res) => {
    if (!isTrustedSource(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('仅允许局域网（RFC1918）或本机访问');
    }
    const peerIp = (req.socket && req.socket.remoteAddress) || '?';
    const gate = tokenGateDecision(req, token, gateSalt);
    if (!gate.ok) {
      // 退避闸：同 IP 60s 内 >=10 次失败即 429（frp 把公网访客呈现为回环/私网，来源闸挡不住爆破）。
      const waitMs = gateLedger.waitMsFor(peerIp);
      if (waitMs !== null) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });
        return res.end('尝试过于频繁，请稍后再试');
      }
      if (gate.redirect !== undefined) {
        res.writeHead(302, { Location: gate.redirect, 'Set-Cookie': gate.cookie, 'Cache-Control': 'no-store' });
        return res.end();
      }
      gateLedger.recordFailure(peerIp);
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('需要访问令牌：在 URL 后附加 ?token=<remoteToken>（只需一次，之后凭 Cookie 访问）');
    }
    gateLedger.clear(peerIp);
    const fwdPath = upstreamPath(req.url);
    session.mergedCookieHeaders(req.headers).then((cookie) => {
      const upstream = http.request(
        { hostname: targetHost, port: targetPort, path: fwdPath, method: req.method, headers: buildForwardHeaders(req, authority, cookie) },
        (ur) => handleUpstream(ur, res, req.url, (status) => {
          if (status === 401 || status === 403) session.invalidate(status);
        }, logger)
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('lobox relay: 上游不可达');
      });
      req.pipe(upstream);
    }).catch(() => {
      const upstream = http.request(
        { hostname: targetHost, port: targetPort, path: fwdPath, method: req.method, headers: buildForwardHeaders(req, authority, req.headers.cookie) },
        (ur) => handleUpstream(ur, res, req.url, null, logger)
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('lobox relay: 上游不可达');
      });
      req.pipe(upstream);
    });
  });

  server.on('upgrade', createTunnelHandler({
    session,
    authority,
    targetHost,
    targetPort,
    getToken: () => token,
    getGateSalt: () => gateSalt,
    gateWaitMs: (ip) => gateLedger.waitMsFor(ip),
    onGateFailure: (ip) => gateLedger.recordFailure(ip),
  }));

  if (session.hasToken()) session.refreshDshSession();

  server.setDshToken = () => { session.refreshDshSession(); return server; };

  server.setToken = (t) => { token = String(t || ''); return server; };

  server.hasToken = () => !!token;

  server.status = () => session.status();

  return server;
}

module.exports = { createRelay, handleUpstream, HTML_INJECT_MAX_BYTES };
