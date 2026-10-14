'use strict';

const net = require('node:net');
// 直接使用唯一判据 tokenGateDecision：不再经 hasValidToken 这层转发，
// 「可漏传 mode」的结构性风险随该函数一起从公开面消失。
const { isTrustedSource, tokenGateDecision, upstreamPath } = require('./core');

function buildRawRequest(req, authority, cookie) {
  let raw = req.method + ' ' + upstreamPath(req.url) + ' HTTP/1.1\r\n';
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    if (k === 'origin') { raw += 'origin: http://' + authority + '\r\n'; continue; }
    if (k === 'cookie') continue;
    raw += k + ': ' + v + '\r\n';
  }
  if (cookie) raw += 'cookie: ' + cookie + '\r\n';
  raw += 'host: ' + authority + '\r\n\r\n';
  return raw;
}

function openTunnel(raw, head, socket, targetHost, targetPort) {
  const upstream = net.connect(targetPort, targetHost, () => {
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const kill = () => {
    try { socket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };
  upstream.on('error', kill);
  socket.on('error', kill);
}

function rejectSocket(socket, statusLine) {
  try { socket.write(statusLine); } catch {}
  try { socket.destroy(); } catch {}
}

// getToken / getGateSalt / getMode 三者由 createRelay 单点注入，缺一即视为装配错误：
// 漏注入 mode 会让 normalizeRemoteMode(undefined) 归一为 'off'，
// 于是 LAN 无令牌的 HTTP 面放行、WS upgrade 却 401 —— 同一道门两种答案。
// 因此这里在入口一次性校验，令牌判据的输入集合在结构上无法被省略。
function createTunnelHandler({ session, authority, targetHost, targetPort, getToken, getGateSalt, getMode, gateWaitMs, onGateFailure }) {
  if (typeof getToken !== 'function' || typeof getGateSalt !== 'function' || typeof getMode !== 'function') {
    throw new Error('createTunnelHandler: getToken/getGateSalt/getMode 必须全部由装配点注入');
  }
  return function onUpgrade(req, socket, head) {
    if (!isTrustedSource(req, socket)) {
      rejectSocket(socket, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const ip = (socket && socket.remoteAddress) || (req.socket && req.socket.remoteAddress) || '?';
    if (typeof gateWaitMs === 'function' && gateWaitMs(ip) !== null) {
      rejectSocket(socket, 'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (tokenGateDecision(req, getToken(), getGateSalt(), getMode()).ok !== true) {
      if (typeof onGateFailure === 'function') { try { onGateFailure(ip); } catch {} }
      rejectSocket(socket, 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    session.ensureDshCookie().then((dshC) => {
      const cookie = session.mergeDshCookie((req.headers.cookie) || '', dshC);
      openTunnel(buildRawRequest(req, authority, cookie), head, socket, targetHost, targetPort);
    }).catch(() => {
      const cookie = session.mergeDshCookie((req.headers.cookie) || '', session.currentCookie());
      openTunnel(buildRawRequest(req, authority, cookie), head, socket, targetHost, targetPort);
    });
  };
}

module.exports = { createTunnelHandler };
