'use strict';

// api/security —— HTTP 层安全判定唯一归属处：Host/Origin 深化校验（CSRF 层）与访问密钥比较。
// 分层：身份层（platform/security/identity.js，socket 事实）判回环/私有网段；本文件防浏览器恶意网页驱动 API；
// 第三层 apiAccessKey 由调用方接（非回环须 Bearer/?access_key=）。不返回 CORS 头（面板同源托管 + 壳源白名单）。

const crypto = require('node:crypto');

// 安全信任根：访问者身份 = socket 层事实（req.socket.remoteAddress），唯一判定实现见 ./identity.js；
// Host/Origin 请求头只做浏览器语义的深化校验，绝不参与身份/鉴权判定。
// isPrivateIpv4 经 identity shim 转述（同一份 RFC1918 判定，Host/Origin 闸复用，不重写第二份）。
const { isPrivateIpv4 } = require('./identity');

// CSRF 深化校验：Host 必须存在且主机属回环/RFC1918 私有网段信任集；带 Origin 时还须主机一致、端口同源。
//   Host 闸防 DNS-rebinding（evil.com 解析到 127.0.0.1 时浏览器带 Host: evil.com，被拒）。
//   CORS 只挡读取不挡 CSRF 副作用，故必须独立做 Origin 闸；若只查回环，开启局域网访问后
//   写操作会全 403（见 isLocalOrLanHost）。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 是否为本机回环主机名（含 IPv6 方括号形态）。 */
function isLoopbackHost(h) {
  if (!h) return false;
  return LOOPBACK_HOSTS.has(String(h).toLowerCase());
}

/** 「本机或局域网」主机名 —— Host/Origin 闸信任集（回环名 + RFC1918 私有 IPv4，复用 identity.isPrivateIpv4）。
 *  开启局域网访问（apiHost=0.0.0.0）后浏览器带 `Host: 192.168.x.x:36360`，若只按回环判定写操作会全 403。
 *  不放宽对公网的拒绝：非私有网段主机（如 evil.com）仍被拒，DNS-rebinding 防护语义不变。 */
function isLocalOrLanHost(h) {
  if (!h) return false;
  const s = String(h).toLowerCase();
  if (LOOPBACK_HOSTS.has(s)) return true;
  const bare = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (bare === '::1') return true;
  return isPrivateIpv4(bare);
}

/** 壳（Tauri webview）的来源：唯一被接受的非回环来源，CORS 与 CSRF 共用的单一事实源。
 *  接受集：tauri: 协议下 localhost 与 *.tauri.localhost；http(s) 下仅 tauri.localhost 本体，不含子域。 */
function isShellOrigin(protocol, hostname) {
  const h = String(hostname || '').toLowerCase();
  if (protocol === 'tauri:') return h === 'localhost' || /(^|\.)tauri\.localhost$/.test(h);
  if (protocol === 'http:' || protocol === 'https:') return h === 'tauri.localhost';
  return false;
}

/** 主机名归一（小写 + 去 IPv6 方括号），用于 Host/Origin 主机一致性比较。 */
function normalizeHostname(h) {
  const s = String(h || '').toLowerCase();
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

function originAllowed(req, apiPort) {
  // 闸 1：Host 头，fail-closed（防 DNS-rebinding）。HTTP/1.1 起 Host 必发，缺失即非规范
  //   客户端直接拒（若缺 Host 放行，与闸 2「无 Origin 放行」组合后两闸同时归零）。
  //   浏览器会把 URL 里的域名放进 Host：非本机/局域网名说明请求来自「被解析到 127.0.0.1 的外部域名」。
  const host = req.headers.host;
  if (!host) return false;
  let hostname = '';
  {
    // Host 形如 `127.0.0.1:36360` / `[::1]:36360` / `evil.com`
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(host).trim());
    hostname = m ? m[1] : String(host).trim();
    if (!isLocalOrLanHost(hostname)) return false;
  }

  // 闸 2：Origin（哪些页面能驱动本 API）。现代浏览器对 POST（含 form 提交）一律发 Origin，
  //   缺 Origin 只可能来自非浏览器客户端，不构成浏览器 CSRF 面；该语义由测试钉死。
  const o = req.headers.origin;
  if (!o) return true; // curl / CLI / 同源 GET 无 Origin
  try {
    const u = new URL(o);
    if (isShellOrigin(u.protocol, u.hostname)) return true;
    // Origin 同样接受私有网段（局域网设备的浏览器就是合法面板来源）。
    if (!isLocalOrLanHost(u.hostname)) return false;
    // 主机一致性（防 LAN CSRF）：Origin 主机必须与请求实际到达的 Host 相同；只比端口会让
    //   局域网内任意主机上端口相同的恶意页面驱动本 API（socket 层是合法私网来源，身份/密钥层不拦）。
    if (host && normalizeHostname(u.hostname) !== normalizeHostname(hostname)) return false;
    const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return port === String(apiPort);
  } catch {
    return false;
  }
}

/** 常数时间字符串比较（防时序侧信道）。 */
function safeKeyEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 请求是否携带正确的出回环访问密钥：Authorization: Bearer <key> 或 ?access_key=<key>
 *  二选一（常数时间比较）。调用方仅在配置了 apiAccessKey 且非回环请求时经此门卫。 */
function requestHasAccessKey(req, key) {
  if (!key) return true;
  const ah = req.headers.authorization;
  if (typeof ah === 'string' && ah.startsWith('Bearer ') && safeKeyEqual(ah.slice(7), key)) return true;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('access_key');
    if (q && safeKeyEqual(q, key)) return true;
  } catch {}
  return false;
}

module.exports = { originAllowed, isLocalOrLanHost, isShellOrigin, isLoopbackHost, requestHasAccessKey };
