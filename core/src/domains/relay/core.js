'use strict';

const crypto = require('node:crypto');
const { isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');
const { remoteTokenStrength } = require('../../shared/credential');
const BRAND = require('../../shared/brand');

// 门卫 cookie 名取自单源：它由**我方**签发与校验（不是 harness 的 `dsh-auth-*`），改名即所有在途 LAN 会话失效。
const LAN_COOKIE_RE = new RegExp('(?:^|;\\s*)' + BRAND.COOKIE_LAN_TOKEN + '=([^;]+)');

// 来源闸收窄到回环/RFC1918：relay 监听 0.0.0.0 且把 Origin/Referer 改写成回环权威，连得上即等于拿到 DSH 特权面（不是鉴权）。
function isTrustedSource(req, sock) {
  const addr = (req && req.socket && req.socket.remoteAddress)
    || (sock && sock.remoteAddress)
    || '';
  if (!addr) return false;
  const norm = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr)
    ? addr.replace(/^::ffff:/i, '')
    : addr.toLowerCase();
  return isLoopbackAddress(norm) || isPrivateIpv4(norm);
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

function upstreamPath(rawUrl) {
  try {
    const u = new URL(rawUrl, 'http://127.0.0.1');
    if (u.searchParams.has('token')) u.searchParams.delete('token');
    return u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  } catch { return rawUrl || '/'; }
}

function lanGateCookieValue(token, salt) {
  const t = String(token == null ? '' : token);
  const s = String(salt == null ? '' : salt);
  if (!t || !s) return '';
  return crypto.createHash('sha256').update(s + '\n' + t).digest('hex');
}

function hasValidToken(req, token, salt, mode) {
  // fail-closed（D1/RL-2）：空令牌即无令牌。但 LAN 模式信任 RFC1918 网络边界
  // （http 层 isTrustedSource 已前置拦截非私网/非本机来源），不构成开放中继 ⇒ 放行；
  // WAN/未指定模式空令牌一律判无授权，杜绝"空令牌开放转发"（开放中继）。
  if (!token) return normalizeRemoteMode(mode) === 'lan';
  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) return true;
  const cookies = req.headers.cookie || '';
  const m = LAN_COOKIE_RE.exec(cookies);
  if (m) {
    try {
      const want = lanGateCookieValue(token, salt);
      return !!want && safeEqual(decodeURIComponent(m[1]), want);
    } catch {
      return false;
    }
  }
  return false;
}

function tokenGateDecision(req, token, salt, mode) {
  // fail-closed（D1/RL-2）：空令牌（含被显式清除）对 WAN/未指定模式一律拒，杜绝"空令牌即开放中继"。
  // LAN 模式信任 RFC1918 网络边界（isTrustedSource 已前置拦截），空令牌放行（非开放中继）。
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


// 日志脱敏：请求路径里可能带 ?token=<secret>（relay 把令牌放在 query）。落日志前剥离 token 参数，
// 避免把用户远程访问令牌写进 lan-daemon.log / guard.log（RL-1）。
function redactLogPath(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl, 'http://127.0.0.1');
    if (u.searchParams.has('token')) u.searchParams.delete('token');
    return u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  } catch { return String(rawUrl || '').replace(/[?&]token=[^&]*/, ''); }
}

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
    // authToken：null/undefined 归一为空串（frpc 遇空串不写 auth.token，避免 String(null)==="null" 被当成共享密钥）；
    //   非空串统一 trim，与 serverAddr 同口径。
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

function backoffGate(f, cfg) {
  const c = cfg || {};
  const max = c.max || 10;
  const windowMs = c.windowMs || 60000;
  const lockMs = c.lockMs || 60000;
  const failCount = Number(f && f.failCount) || 0;
  const firstAt = Number(f && f.firstAt) || 0;
  const now = Number(f && f.now) || 0;
  if (!failCount || !firstAt || now - firstAt >= windowMs) return { waitMs: null };
  if (failCount < max) return { waitMs: null };
  return { waitMs: Math.max(0, lockMs - (now - firstAt)) };
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
  hasValidToken,
  lanGateCookieValue,
  redactLogPath,
  tokenGateDecision,
  backoffGate,
  POLYFILL_SCRIPT,
  buildFrpcToml,
  normalizeFrpSettings,
  normalizeRemoteMode,
  generateRemoteToken,
  validateFrpServerSettings,
  validateWanAccess,
  projectRemoteView,
};
