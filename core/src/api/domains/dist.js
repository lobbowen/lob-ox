'use strict';

// 域：镜像源分发 API（/dist/registry*，DistributionManager 统一管理）。
const { isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');

function owns(pathname) {
  return pathname.startsWith('/dist/');
}

/** 盲 SSRF 收口：探测目标策略，返回错误文案，放行返回 null。
 *  1) 已配置镜像源（distribution 唯一事实源 effectiveOrigins）按 hostname 放行——操作者有意配置的内网镜像必须仍可测试；
 *  2) 其余只允许公网主机：拒回环/RFC1918/链路本地/CGNAT/保留段/localhost 与 .local .internal .home.arpa 后缀/全部 IPv6 字面量。
 *  跳转封堵在 platform/distribution/registry-ref.js 的 fetchRegistry：redirect:'manual' 且逐跳复验
 *  目标主机，故 302 到内网绕不过本策略（健康的 302 型镜像仍可探测）。 */
function probeTargetError(origin, sup) {
  let u = null;
  try { u = new URL(origin); } catch { return 'origin 不是合法 URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'origin 必须以 http(s):// 开头';
  if (u.username || u.password) return 'origin 不允许携带用户名或密码';
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'origin 缺少主机名';

  // 1) 已配置镜像源：按 hostname 放行
  let configured = [];
  try {
    configured = (sup && sup.dist && typeof sup.dist._registryOrigins === 'function')
      ? (sup.dist._registryOrigins() || []) : [];
  } catch { configured = []; }
  for (const c of configured) {
    try { if (new URL(String(c)).hostname.toLowerCase().replace(/^\[|\]$/g, '') === host) return null; } catch {}
  }

  // 2) 其余仅允许公网主机
  const deny = '安全策略：探测目标仅允许公网地址（已配置的镜像源不在此限）';
  // IPv6 字面量一律拒绝，无需枚举分段：URL 会把 ::ffff:127.0.0.1 归一成 ::ffff:7f00:1 这类
  // 十六进制形态，逐段判前缀有绕过面；镜像源应写域名或 IPv4，已配置源已在上一分支放行。
  if (host.includes(':')) return deny;
  // 单标签主机名（无点）拒绝：内网 DNS 短名（intranet/metadata/…）会经搜索域解析到内网。
  if (!host.includes('.')) return deny;
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return deny;
  if (isLoopbackAddress(host) || isPrivateIpv4(host)) return deny;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const o = Number(v4[1]), t = Number(v4[2]);
    if (o === 0 || o >= 224) return deny;              // 未指定 / 组播 / 保留
    if (o === 169 && t === 254) return deny;            // 链路本地（含云元数据 169.254.169.254）
    if (o === 100 && t >= 64 && t <= 127) return deny;  // CGNAT
  }
  return null;
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    // 全局统一分发：镜像源配置由 DistributionManager 统一管理（DSH 自升级 + 反代共用）——仅 /dist/registry*。
    if (req.method === 'GET' && pathname === '/dist/registry') {
      Promise.resolve(sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/set') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      // 被校验闸拒绝的配置不能回 200：setRegistryConfig 的拒因写在返回对象的 error 字段（无 ok 键），
      // 而 UI 的 http() 只在 !res.ok 时抛错——回 200 会让被 SSRF 闸拦下的镜像源仍弹「已保存」。
      // 故按拒因归真为 400 + ok:false。
      collectBody(req, res, 8192, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        Promise.resolve(sup.dist.setRegistryConfig(j)).then((r) => {
          const msg = r && r.error ? String(r.error) : '';
          send(msg ? 400 : 200, msg ? { ok: false, ...r } : { ok: true, ...r });
        }).catch((e) => send(500, { ok: false, error: e.message }));
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/refresh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      sup.dist.selectRegistry(true).then(() => sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    // 同源镜像探活端点：浏览器直连用户填写的镜像源会被本页 CSP connect-src 'self' 在发起前拦截，
    // UI 无法区分「真的不可达」与「被策略阻断」；服务端 fetch 不受页面 CSP 约束，故走本端点。
    if (req.method === 'POST' && pathname === '/dist/registry/probe') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return collectBody(req, res, 4096, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        const origin = String(j.origin || '').trim();
        // 协议层第一道闸：有测试以源码形态钉住此字面校验，勿删。
        if (!/^https?:\/\//.test(origin)) return send(400, { ok: false, error: 'origin 必须以 http(s):// 开头' });
        const targetErr = probeTargetError(origin, sup);
        if (targetErr) return send(400, { ok: false, error: targetErr });
        Promise.resolve(sup.dist.probeOrigin(origin))
          .then((r) => send(200, { ok: true, ...r }))
          .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      });
    }

  // 域内未匹配(方法/子路径)：全局兜底语义
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
