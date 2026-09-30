'use strict';

// relay 域纯层：只有判定与构造，不 require node:fs/http/https/net/child_process（副作用一律在 proxy/session/tunnel/frp）。

const crypto = require('node:crypto');
// 来源判定复用 shared/ip 的同一份实现，本域不得写第二份。
const { isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');
// 令牌强度下限由多个消费点共用，故实现在 shared/credential（DS-G1 禁跨域边）。
const { remoteTokenStrength } = require('../../shared/credential');

/** 来源地址是否可信（回环 或 RFC1918 私有网段）。
 *  relay 监听 0.0.0.0 且把 Origin/Referer 改写成回环权威，「连得上」就等于拿到 DSH 特权面，
 *  故来源闸收窄到回环与私有网段；这不是鉴权——私网内仍是共享信任域。
 */
function isTrustedSource(req, sock) {
  const addr = (req && req.socket && req.socket.remoteAddress)
    || (sock && sock.remoteAddress)
    || '';
  if (!addr) return false;
  // Node 对 IPv4-mapped IPv6 呈现::ffff:a.b.c.d —— 归一到 IPv4 字面量后再判定。
  const norm = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr)
    ? addr.replace(/^::ffff:/i, '')
    : addr.toLowerCase();
  return isLoopbackAddress(norm) || isPrivateIpv4(norm);
}

/** 常数时间比较（先 sha256 归一到定长，避免长度侧信道）。 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 提取 Cookie 头中给定名字的值（只按分号切段，不做通用 Cookie 解析）。 */
function cookieByName(headerValue, name) {
  if (!headerValue) return null;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
  }
  return null;
}

/** 转发给上游的路径：剥离 ?token=。门卫令牌只服务于 relay 准入，随 path 落进 DSH 访问日志与
 *  Referer 链；DSH 自身启动令牌不经此路（/open bootstrap 走回环直连）。HTTP 与 tunnel 共用本实现。 */
function upstreamPath(rawUrl) {
  try {
    const u = new URL(rawUrl, 'http://127.0.0.1');
    if (u.searchParams.has('token')) u.searchParams.delete('token');
    return u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  } catch { return rawUrl || '/'; }
}

/** 门卫会话 cookie 值：`sha256(salt + '\n' + token)`。cookie 存派生值而非令牌明文，被记录/截获都不等于门卫令牌
 *  （匹配 kinds 'lan-gate' 声明），两者可分开轮换；salt 为 relay 进程随机数，重启即全部会话失效。
 *  @returns {string} hex；salt/token 任一缺失返回 ''（调用方据此拒绝匹配）。 */
function lanGateCookieValue(token, salt) {
  const t = String(token == null ? '' : token);
  const s = String(salt == null ? '' : salt);
  if (!t || !s) return '';
  return crypto.createHash('sha256').update(s + '\n' + t).digest('hex');
}

/** 请求是否携带有效令牌（纯判定，无 IO）。Cookie 档只认派生值，门卫令牌原文只允许经 ?token= 一次性出示。 */
function hasValidToken(req, token, salt) {
  if (!token) return true;
  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) return true;
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
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

/** 令牌门卫决策（HTTP 响应路径）。纯函数，应答由调用方落笔。
 *  @param salt relay 进程随机盐；缺失 = 无法签发/校验会话 cookie，fail-closed
 *  @returns {ok:true} 放行 | {ok:false, redirect, cookie} 首次凭 URL 令牌进入，302 种派生会话 Cookie | {ok:false, unauthorized:true} 401
 */
function tokenGateDecision(req, token, salt) {
  if (!token) return { ok: true };
  const url = new URL(req.url, 'http://localhost');
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
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
      // 令牌条 5：种派生会话值，绝不是门卫令牌原文。
      cookie: 'dsh_lan_token=' + lanGateCookieValue(token, salt) + '; Path=/; HttpOnly; SameSite=Lax',
    };
  }
  return { ok: false, unauthorized: true };
}

// 非回环 HTTP 源不是 secure context，crypto.randomUUID 缺失，而 DSH 客户端用它生成每个 RPC 的
// id —— 缺失即所有请求抛错、WS 就绪握手失败。反代在 HTML 注入此 polyfill 补齐。
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

/** 生成 frpc.toml 文本（纯，无 IO）。
 *  loginFailExit 必须为 false：frpc 默认 true 时首次连不上 frps 即退出且不重试，隧道永久失效。
 *  端口纪律：公网口与本机 relay 口恒同号（remotePort = wanPort），不存在第二套端口分配；
 *  wanPort 未分配（非正整数）的实例不得写出 [[proxies]]。 */
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

/** frp 设置归并（patch 覆盖现值，纯）：设置面只有连接参数，没有总闸（见 frp.js 生命周期条件）。 */
function normalizeFrpSettings(patch, current) {
  const j = patch || {};
  const cur = current || {};
  return {
    serverAddr: String(j.serverAddr !== undefined ? j.serverAddr : cur.serverAddr).trim(),
    serverPort: Number(j.serverPort) || cur.serverPort,
    authToken: String(j.authToken !== undefined ? j.authToken : cur.authToken),
    user: String(j.user || cur.user || 'dsh'),
  };
}

/** frp 服务器地址前置校验（纯）：serverAddr 为空时 frpc 只会连到空地址、永不建隧道。
 *  wan 模式写入闸与 frp.start() 执行边界共用本判定。 */
function validateFrpServerSettings(settings) {
  const s = settings || {};
  if (!String(s.serverAddr || '').trim()) {
    return { ok: false, error: '启用公网访问前必须填写服务器地址（serverAddr）' };
  }
  return { ok: true };
}

/** 凭据失败退避判定（纯）：计时与账本由调用方（proxy 层内存 Map）持有。
 *  门卫校验本身无状态，否则公网侧可无限速爆破。
 *  @param {{failCount:number, firstAt:number, now:number}} f  @param {{max:number, windowMs:number, lockMs:number}} [cfg]
 *  @returns {{waitMs:number|null}} null=可立即尝试；否则须等待的毫秒数 */
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

/** 公网访问（wan）前置安全闸（纯）：relay 空 token 恒放行 + 回环呈现，故进入 wan 前强制要求已设且强度
 *  达下限（remoteTokenStrength）的访问令牌，否则 DSH 特权接口对公网零认证可达。端口无自由度（公网口与
 *  relay 口恒同号），端口合法性/占用不在本闸——由 relay 槽位注册表单一事实源保证。 */
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

/** 门卫令牌的唯一分配口。长度与字符集由本函数一处定义：只出 URL-safe 字符，
 *  因为 relay 的令牌一次性出示形态是 `?token=`（proxy.js 的 401 提示语），非 URL-safe 会逼每个
 *  消费方各自转义。放 core.js 而非 shared/credential：shared 层零 require 纪律不容纳随机源，
 *  而令牌形态本就是 relay 门卫的知识；分配只被远程控制写入口消费，不存在第二处生成。 */
function generateRemoteToken() {
  return crypto.randomBytes(12).toString('base64url');
}

/** 远程访问模式读侧归一（纯）：磁盘/快照记录可能缺字段，一律收敛到 'off'，消费方不做真值猜测。 */
function normalizeRemoteMode(v) {
  return v === 'lan' || v === 'wan' ? v : 'off';
}

/** 远程访问视图投影（纯）——URL 与就绪态的唯一事实源，前端零判定直消费。
 *  ready = relay 在听 且 DSH 会话 cookie 已注入（relay 未监听时无从注入，故注入因走 else-if 不叠加）；
 *  wan 另要求已设令牌 + frps 地址 + frpc 隧道在跑。未就绪原因按优先级列在 reasons 供 UI 呈现。
 *  访问令牌只在 wan 计入就绪：relay 空令牌恒放行（tokenGateDecision），局域网侧「没设令牌」不阻断访问，
 *  把它挂到就绪位等于用「能不能访问」表达「够不够安全」；而公网侧空令牌 = DSH 特权面零认证可达，
 *  故 wan 必须计入。accessUrl 与 ready 正交：端口/地址已定即给出地址，未就绪也要让用户看得见要访问什么。
 *  @param {{mode,relayListening,cookieReady,tokenSet,frpcRunning,serverAddr,lanAddress,wanPort}} v */
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
