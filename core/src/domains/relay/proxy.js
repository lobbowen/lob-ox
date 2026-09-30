'use strict';

// 局域网反向代理 server 本体：在 0.0.0.0:<wanPort> 监听，把 LAN 流量转发到 127.0.0.1:<dshPort>，
// 做回环呈现（Origin/Referer 改写为回环权威）+ HTML polyfill 注入 + 断线保持，并暴露 setToken/setDshToken/hasToken/status。
// 硬边界：DSH 本体只监听 127.0.0.1，不改其源码/配置/插件；访问控制（令牌闸、来源闸）全部留在反代层。

const http = require('node:http');
const crypto = require('node:crypto');
const { isTrustedSource, tokenGateDecision, backoffGate, upstreamPath, POLYFILL_SCRIPT } = require('./core');
const { createSession } = require('./session');
const { createTunnelHandler } = require('./tunnel');

/** HTML polyfill 注入的全量缓冲上限（D-5）：超上限放弃注入按流透传，绝不无界缓冲。
 *  取 2MB：DSH 壳文档远小于此；上限只兜异常上游，同时把并发最坏情形钉在可算的内存量级。 */
const HTML_INJECT_MAX_BYTES = 2 * 1024 * 1024;

/** 门卫令牌失败退避账本：按来源 IP 计失败，窗口内超阈值即拒（429）。
 *  判定在纯函数 core.backoffGate，本层只管计时与账本（仅内存，进程重启即清空）。 */
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

/** 流式转发 + 断线保持：浏览器断开时不 destroy 上游，继续读并丢弃，直到上游自然结束。
 *  destroy 会让 DSH 判定客户端离线并取消 agent；保持下 agent 结果仍落 DSH 会话，浏览器重连可见。
 *  保持模式不设时限。 */
function pipeWithHold(ur, res, clientReqPath, logger) {
  let clientGone = false;
  const log = (lv, msg) => { if (logger && logger[lv]) { try { logger[lv]('[relay] ' + msg); } catch {} } };
  ur.on('data', (c) => {
    if (clientGone) return; // 浏览器已断：丢弃数据但保持读取（DSH 连接不阻塞、不被判死）
    if (!res.write(c)) ur.pause();
  });
  res.on('drain', () => ur.resume());
  ur.on('end', () => {
    if (clientGone) log('info', 'relay: 上游响应自然结束（agent 完成，消息已落 DSH 会话）' + (clientReqPath ? ' ' + clientReqPath : ''));
    try { if (!clientGone) res.end(); } catch {}
  });
  ur.on('error', () => {
    try { if (!clientGone) res.end(); } catch {}
    try { ur.destroy(); } catch {}
  });
  res.on('close', () => {
    if (ur.readableEnded || ur.destroyed) return;
    // 浏览器中途断开：进入保持模式——继续读上游丢弃，等 DSH 自然结束（不取消 agent、不清理）
    clientGone = true;
    log('warn', 'relay: 客户端连接断开，保持上游连接直到响应结束（agent 不受影响）' + (clientReqPath ? ' ' + clientReqPath : ''));
  });
}

/** 构造转发到 DSH 的请求头：回环呈现 + 强制 identity 编码（HTML 注入需要明文 body）。 */
function buildForwardHeaders(req, authority, cookie) {
  const headers = { ...req.headers };
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers.host = authority;
  // 强制上游不压缩：HTML 注入 polyfill 需要明文 body；否则 gzip 流被字符串替换破坏。
  headers['accept-encoding'] = 'identity';
  // 回环呈现：围栏要求 Origin 与 Host 权威一致。
  if (headers.origin !== undefined) headers.origin = 'http://' + authority;
  if (headers.referer !== undefined) headers.referer = 'http://' + authority + '/';
  return headers;
}

/** 处理上游响应：HTML 注入 polyfill，其余流式转发（含断线保持）。 */
function handleUpstream(ur, res, clientReqPath, onStatus, logger) {
  if (onStatus) onStatus(ur.statusCode);
  const h = { ...ur.headers };
  const isHtml = String(h['content-type'] || '').includes('text/html');
  if (isHtml) {
    // HTML 文档禁缓存：局域网设备永远拿到最新前端，避免陈旧壳加载失败态。
    h['cache-control'] = 'no-store';
    // 防御：若上游仍带压缩头（异常路径），移除以免浏览器按 gzip 解码明文注入后的 body。
    delete h['content-encoding'];
    // 移除长度约束：注入脚本后体积变化，改用分块传输。
    delete h['content-length'];
    h['transfer-encoding'] = 'chunked';
  }
  res.writeHead(ur.statusCode || 502, h);
  if (!isHtml) { pipeWithHold(ur, res, clientReqPath, logger); return; }
  // polyfill 注入需全量缓冲整份文档，故有 HTML_INJECT_MAX_BYTES 上限（强制 identity，体积即真实字节）。
  // 越限时不截断（半份 HTML 会让浏览器拿到坏文档），改为放弃注入、按原始流透传并留痕降级。
  const chunks = [];
  let total = 0, passed = false, done = false;
  const log = (msg) => { if (logger && logger.warn) { try { logger.warn('[relay] ' + msg); } catch {} } };
  // 越限的当前块不能指望后挂的 pipeWithHold 写出（本次 data 分发已开始），ur.end 已抢先到达时后挂
  // 监听器也永不触发——两处都必须在这里显式收口，否则浏览器永久挂在未结束的 chunked 响应上。
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
    log('HTML 超上限 ' + HTML_INJECT_MAX_BYTES + 'B（已收 ' + total + 'B），放弃 polyfill 注入按流透传 ' + (clientReqPath || ''));
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

/** 创建局域网反向代理（回环目标 targetHost:targetPort），返回 http.Server（附 setToken/hasToken/setDshToken/status）。
 *  opts: token 门卫令牌（remoteToken；空 = 不设门卫恒放行）；dshTokenOf DSH 启动令牌按需读取函数（TK-4），
 *  dshToken 仅为旧调用方的初值；id/logger/events。 */
function createRelay(targetHost, targetPort, opts) {
  const o = opts || {};
  // 门卫令牌要经 setToken 热更新，故必须是可变量。
  let token = o.token || '';
  const logger = o.logger || null;
  const authority = targetHost + ':' + targetPort;
  // 门卫会话盐：每进程随机，cookie 只存派生值（见 core.lanGateCookieValue），令牌原文永不上会话通道。
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
    // 来源闸：公网来源一律拒绝（relay 只听私网/回环，见 core.isTrustedSource）。
    if (!isTrustedSource(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('仅允许局域网（RFC1918）或本机访问');
    }
    const peerIp = (req.socket && req.socket.remoteAddress) || '?';
    const gate = tokenGateDecision(req, token, gateSalt);
    if (!gate.ok) {
      // 退避闸：同 IP 60s 窗口内 >=10 次失败即 429，封堵门卫令牌的无限速爆破
      // （frp 通道会把公网访客呈现为回环/私网来源，来源闸挡不住）。
      const waitMs = gateLedger.waitMsFor(peerIp);
      if (waitMs !== null) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });
        return res.end('尝试过于频繁，请稍后再试');
      }
      if (gate.redirect !== undefined) {
        // C-4：no-store，防带凭证的响应被缓存。
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
          // 会话自愈：上游 401/403 时清 cookie，下次请求重换。
          if (status === 401 || status === 403) session.invalidate(status);
        }, logger)
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dsh-supervisor relay: 上游不可达');
      });
      req.pipe(upstream);
    }).catch(() => {
      // 换取 cookie 意外异常：仍按客户端原 cookie 转发（旧版 DSH 可用），绝不吞请求。
      const upstream = http.request(
        { hostname: targetHost, port: targetPort, path: fwdPath, method: req.method, headers: buildForwardHeaders(req, authority, req.headers.cookie) },
        (ur) => handleUpstream(ur, res, req.url, null, logger)
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dsh-supervisor relay: 上游不可达');
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

  // 初始令牌：池中已有即换取，避免首个请求等待 cookie。
  if (session.hasToken()) session.refreshDshSession();

  /** 令牌轮换后重置并重换 DSH 会话 cookie（真实值一律由 dshTokenOf() 按需读取）。 */
  server.setDshToken = () => { session.refreshDshSession(); return server; };

  /** 热更新门卫令牌（remoteToken 变更时由 LanManager.syncProxy 下发）。 */
  server.setToken = (t) => { token = String(t || ''); return server; };

  /** 门卫令牌是否已设置：只回布尔，绝不回传令牌明文。 */
  server.hasToken = () => !!token;

  /** 注入状态快照（远程就绪诊断）：不含令牌/cookie 明文。 */
  server.status = () => session.status();

  return server;
}

// handleUpstream/HTML_INJECT_MAX_BYTES 为 D-5 测试缝（回归直接注入假上游，不启真服务/真端口）。
module.exports = { createRelay, handleUpstream, HTML_INJECT_MAX_BYTES };
