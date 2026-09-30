'use strict';

// IP 地址纯函数（L0，出度 0）。HTTP 请求到 socket 的事实判定见 platform/security/identity.js。

/** 规范 socket 远端地址：IPv4-mapped IPv6（ffff:a.b.c.d）归一为 IPv4 字面量。 */
function normalizeRemoteAddress(ra) {
  if (typeof ra !== 'string' || !ra) return null;
  // Node 对 IPv4-mapped IPv6 呈现::ffff:a.b.c.d
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ra);
  return m ? m[1] : ra.toLowerCase();
}

function isLoopbackAddress(ra) {
  const a = normalizeRemoteAddress(ra);
  if (!a) return false;
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

function isPrivateIpv4(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const o = Number(m[1]), t = Number(m[2]);
  if (o === 10) return true;
  if (o === 172 && t >= 16 && t <= 31) return true;
  if (o === 192 && t === 168) return true;
  return false;
}

/** 主机字面量是否落在「非公网」段；入参为 URL.hostname 去方括号后的字面量（调用方负责小写归一）。
 *  判定范围与 api/domains/dist.js 的探测闸一致：回环 / RFC1918 / 链路本地（含 169.254.169.254 元数据）/ CGNAT 100.64/10 /
 *  0/8 与组播保留 224+ / IPv6 字面量（含 ::1、ULA、fe80: 一律拒，因 URL 归一后的 ::ffff:7f00:1 形态逐段判有绕过面）/
 *  特殊后缀（localhost/.local/.internal/.home.arpa）/ 单标签短名（内网 DNS 搜索域）。域名公网解析不在此判（无 DNS 不能定性），写盘闸只拦字面量。 */
function isPrivateHostLiteral(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h.includes(':')) return true;                       // IPv6 字面量一律非公网信任集
  if (!h.includes('.')) return true;                      // 单标签短名走内网搜索域
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')
    || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (isLoopbackAddress(h) || isPrivateIpv4(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const o = Number(v4[1]), t = Number(v4[2]);
    if (o === 0 || o >= 224) return true;                 // 未指定 / 组播 / 保留
    if (o === 127) return true;                           // 整个 127/8 都是回环，不只 127.0.0.1
    if (o === 169 && t === 254) return true;              // 链路本地（含云元数据）
    if (o === 100 && t >= 64 && t <= 127) return true;    // CGNAT
  }
  return false;
}

module.exports = { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4, isPrivateHostLiteral };
