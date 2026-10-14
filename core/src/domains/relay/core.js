'use strict';

const crypto = require('node:crypto');
const { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');
const { remoteTokenStrength } = require('../../shared/credential');
const BRAND = require('../../shared/brand');

// 环回或 RFC1918 私网地址视为可信来源（LAN 模式的判定入口）。
// 归一化走 ip.js 的 normalizeRemoteAddress 单源（已含 ::ffff: 剥离 + toLowerCase）。
function isTrustedAddress(addr) {
  const norm = normalizeRemoteAddress(addr);
  if (!norm) return false;
  return isLoopbackAddress(norm) || isPrivateIpv4(norm);
}

const LAN_COOKIE_RE = new RegExp('(?:^|;\\s*)' + BRAND.COOKIE_LAN_TOKEN + '=([^;]+)');

function isTrustedSource(req, sock) {
  const addr = (req && req.socket && req.socket.remoteAddress)
    || (sock && sock.remoteAddress)
    || '';
  if (!addr) return false;
  // normalizeRemoteAddress 已含 ::ffff: 剥离 + toLowerCase，与 ip.js 其余判定共用单源。
  return isTrustedAddress(addr);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function cookieByName(headerValue, name) {
  if (!headerValue) return null;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
  }
  return null;
}

function stripGateTokenAndPreserve(rawUrl) {
  if (!rawUrl) return '/';
  let url = rawUrl;
  const hashIdx = url.indexOf('#');
  if (hashIdx >= 0) url = url.slice(0, hashIdx); 
  const qIdx = url.indexOf('?');
  const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
  if (qIdx < 0) return path || '/';
  const query = url.slice(qIdx + 1);
  if (!query) return path || '/';
  const kept = [];
  for (const pair of query.split('&')) {
    if (!pair) { kept.push(pair); continue; }
    const eq = pair.indexOf('=');
    const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
    let key = rawKey;
    try { key = decodeURIComponent(rawKey); } catch {}
    if (key === 'token') continue; 
    kept.push(pair);
  }
  const out = path || '/';
  return kept.length ? out + '?' + kept.join('&') : out;
}

function upstreamPath(rawUrl) {
  
  return stripGateTokenAndPreserve(rawUrl);
}

const POLYFILL_SCRIPT = `<script>
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function () {
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = '';
    for (var i = 0; i < 16; i++) h += (i === 4 || i === 6 || i === 8 || i === 12 ? '-' : '') + ('0' + b[i].toString(16)).slice(-2);
    return h;
  };
}
</script>`;

function redactLogPath(rawUrl) {
  
  
  return rawUrl ? stripGateTokenAndPreserve(rawUrl) : '';
}

function lanGateCookieValue(token, salt) {
  const t = String(token == null ? '' : token);
  const s = String(salt == null ? '' : salt);
  if (!t || !s) return '';
  return crypto.createHash('sha256').update(s + '\n' + t).digest('hex');
}

function tokenGateDecision(req, token, salt, mode) {
  
  
  if (!token) return normalizeRemoteMode(mode) === 'lan' ? { ok: true } : { ok: false, unauthorized: true };
  const url = new URL(req.url, 'http://localhost');
  const cookies = req.headers.cookie || '';
  const m = LAN_COOKIE_RE.exec(cookies);
  if (m) {
    try {
      const want = lanGateCookieValue(token, salt);
      if (want && safeEqual(decodeURIComponent(m[1]), want)) return { ok: true };
    } catch {}
  }
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) {
    return {
      ok: false,
      redirect: url.pathname,
      cookie: BRAND.COOKIE_LAN_TOKEN + '=' + lanGateCookieValue(token, salt) + '; Path=/; HttpOnly; SameSite=Lax',
    };
  }
  return { ok: false, unauthorized: true };
}

// 令牌闸门的唯一判据就是 tokenGateDecision：WS 隧道面与 HTTP 面调用同一个函数、
// 传同一组输入（token / salt / mode），因此对同一请求不可能给出两种答案。
// 此处原先还有一个 hasValidToken 转发层与一个 tokenGateDecision 平行实现
// （query token 正确时前者放行、后者要求种 cookie）。转发层已删除：
// 多一层包装就多一处「可以漏传参数」的公开面，判据只有一处、调用只有一处。
function buildFrpcToml(settings, instances) {
  const s = settings || {};
  const lines = [];
  lines.push('serverAddr = "' + (s.serverAddr || '').replace(/"/g, '') + '"');
  lines.push('serverPort = ' + (Number(s.serverPort) || 7000));
  if (s.authToken) lines.push('auth.token = "' + String(s.authToken).replace(/"/g, '') + '"');
  lines.push('loginFailExit = false');
  lines.push('');
  let count = 0;
  for (const inst of instances || []) {
    if (normalizeRemoteMode(inst.remoteMode) !== 'wan' || !Number.isInteger(inst.wanPort) || inst.wanPort <= 0) continue;
    const name = (s.user || 'dsh') + '-lan-' + String(inst.id).slice(-8);
    lines.push('[[proxies]]');
    lines.push('name = "' + name.replace(/"/g, '') + '"');
    lines.push('type = "tcp"');
    lines.push('localIP = "127.0.0.1"');
    lines.push('localPort = ' + inst.wanPort);
    lines.push('remotePort = ' + inst.wanPort);
    lines.push('');
    count++;
  }
  return { text: lines.join('\n'), count };
}

function normalizeFrpSettings(patch, current) {
  const j = patch || {};
  const cur = current || {};
  return {
    serverAddr: String(j.serverAddr !== undefined ? j.serverAddr : cur.serverAddr).trim(),
    serverPort: Number(j.serverPort) || cur.serverPort,
    
    
    authToken: (j.authToken === undefined ? cur.authToken : (j.authToken == null ? '' : String(j.authToken).trim())),
    user: String(j.user || cur.user || 'dsh'),
  };
}

function validateFrpServerSettings(settings) {
  const s = settings || {};
  if (!String(s.serverAddr || '').trim()) {
    return { ok: false, error: '启用公网访问前必须填写服务器地址（serverAddr）' };
  }
  return { ok: true };
}


function validateWanAccess({ remoteToken }) {
  const strength = remoteTokenStrength(remoteToken);
  if (!strength.ok) {
    const error = strength.reason === 'short'
      ? '远程访问令牌（remoteToken）至少 8 位：公网暴露可被暴力枚举，过短令牌等同无令牌'
      : '开启公网访问前请先为该实例设置远程访问令牌（remoteToken），否则 DSH 特权接口将对公网完全开放';
    return { ok: false, error };
  }
  return { ok: true };
}

function generateRemoteToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function normalizeRemoteMode(v) {
  return v === 'lan' || v === 'wan' ? v : 'off';
}

function projectRemoteView(v) {
  const x = v || {};
  const mode = normalizeRemoteMode(x.mode);
  if (mode === 'off') return { mode, ready: false, accessUrl: null, reasons: [] };
  const reasons = [];
  if (!x.relayListening) reasons.push('远程服务未就绪（relay 未监听）');
  else if (!x.cookieReady) reasons.push('正在注入 DSH 会话…');
  if (mode === 'wan') {
    if (!x.tokenSet) reasons.push('未设访问令牌');
    if (!String(x.serverAddr || '').trim()) reasons.push('未配置 frps 服务器地址');
    if (!x.frpcRunning) reasons.push('公网隧道未建立（frpc 未运行）');
  }
  const ready = !reasons.length;
  let accessUrl = null;
  if (Number.isInteger(x.wanPort) && x.wanPort > 0) {
    const host = mode === 'wan' ? String(x.serverAddr || '').trim() : String(x.lanAddress || '').trim();
    if (host) accessUrl = 'http://' + host + ':' + x.wanPort + '/';
  }
  return { mode, ready, accessUrl, reasons };
}

module.exports = {
  isTrustedSource,
  cookieByName,
  upstreamPath,
  lanGateCookieValue,
  redactLogPath,
  tokenGateDecision,
  POLYFILL_SCRIPT,
  buildFrpcToml,
  normalizeFrpSettings,
  normalizeRemoteMode,
  generateRemoteToken,
  validateFrpServerSettings,
  validateWanAccess,
  projectRemoteView,
};
