'use strict';

// 「一个可用的镜像源到底是什么」的单一所有者。此前这句话在两侧各解释一遍：壳的目录允许基址带路径
// （华为云/腾讯云本来就是这个形态），内核的闸把「不得带 path」当安全判据 —— 结果是一批准许的镜像
// 在探测阶段判可达、在消费阶段判非法，面板表现为「取不到版本也下载不了」。
// 本模块把四件事各自定义一次：形态与安全（parseRegistryBase）、交给 npm 的注入形态（registryEnvPair）、
// 包名 URL（registryPackagePath）、传输与跳转复验（fetchRegistry）。

const { isPrivateHostLiteral } = require('../../shared/ip');

/** 跳转复验的上界：registry 正常一跳足够，再多就是给 302 链当跳板。 */
const REDIRECT_MAX_HOPS = 3;

/** 单次响应体字节上界：全量 packument 也远小于此，防镜像被换成大文件拖死取版本路径。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 10000;

/** 归一：去空白 + 剥尾斜杠（`https://host/` 与 `https://host` 是同一个源）。 */
function normalizeBase(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
}

/** 主机维度的安全闸（配置源与跳转目标共用）：私网/回环字面量一律拒。
 *  已配置的内网镜像由 API 层的探测端点按其 hostname 豁免，与本闸分工不同。 */
function hostViolation(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return '镜像源缺少主机名';
  if (isPrivateHostLiteral(h)) return '镜像源主机不得为回环/私网/链路本地/保留段字面量: ' + h;
  return null;
}

/** 配置的镜像基址：**只做形态判定**（协议白名单 + 无凭证/查询/片段 + 允许 path）。
 *  主机维度不在此处：私网字面量闸在写入口（policies.registryOriginViolation）与跨主机跳转
 *  （targetHostViolation）两处施加。把两者混在这一把尺里的旧形态，会让「合法带 path 的镜像」
 *  与「夹带凭证的基址」得到同一个答案 —— 前者被误杀、后者被放过。
 *  @returns {{ok:boolean, base:string, protocol:string, host:string, violation:string|null}} */
function parseRegistryBase(raw) {
  const base = normalizeBase(raw);
  const bad = (violation) => ({ ok: false, base, protocol: '', host: '', violation });
  if (!base) return bad('镜像源为空');
  if (/[\s]/.test(base)) return bad('镜像源不得含空白字符');
  let u;
  try { u = new URL(base); } catch { return bad('镜像源无法解析: ' + base); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return bad('镜像源必须是 http(s) 协议: ' + base);
  if (u.username || u.password) return bad('镜像源不得携带用户名或密码: ' + base);
  if (u.search) return bad('镜像源不得携带查询串: ' + base);
  if (u.hash) return bad('镜像源不得携带片段: ' + base);
  if (!u.hostname) return bad('镜像源缺少主机名: ' + base);
  return { ok: true, base, protocol: u.protocol.replace(/:$/, ''), host: u.hostname, violation: null };
}

/** 跳转目标复验：主机维度。镜像站的常见形态是「同主机 302 到自家 CDN 存储」，那不是权限扩张
 *  （起点主机已由操作者配置），一律拒绝会把健康镜像判死；**跨主机**跳转才是 SSRF 边界，
 *  目标主机必须自己过私网字面量闸。 */
function targetHostViolation(rawUrl, fromUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return '跳转目标无法解析'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '跳转目标协议非法: ' + u.protocol;
  if (u.username || u.password) return '跳转目标不得携带凭证';
  let from;
  try { from = new URL(String(fromUrl || '')); } catch { from = null; }
  if (from && from.hostname.toLowerCase() === u.hostname.toLowerCase()) return null;
  return hostViolation(u.hostname);
}

/** 包名转 registry 路径段（编码规则唯一出口；两侧不一致会让「探测可达」与「取到字节」分叉）。 */
function registryPackagePath(pkg) {
  return encodeURIComponent(String(pkg || ''));
}

/** base + 路径段的唯一拼接口（避免各处各写一次斜杠处理）。 */
function registryUrl(base, ...segments) {
  const parsed = parseRegistryBase(base);
  if (!parsed.ok) return null;
  const tail = segments.filter((s) => s !== '' && s != null)
    .map((s) => String(s).replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean).join('/');
  return tail ? parsed.base + '/' + tail : parsed.base;
}

/** 镜像基址转成交给 npm 子进程的环境变量对（唯一注入口）。「哪两个键有效」与「什么基址可用」
 *  必须同源：注入点一旦各写一遍，就会有的过闸有的不过闸，面板显示一个源而子进程用另一个源。
 *  非法基址回 `{ok:false, violation}` 且**不给半个键** —— 把 null 或非法值写进 env 会让 npm 收到
 *  字面 'null'，报出与真实原因（镜像不可达/基址非法）无关的错。 */
function registryEnvPair(base) {
  const parsed = parseRegistryBase(base);
  if (!parsed.ok) return { ok: false, violation: parsed.violation, base: null, env: null };
  return {
    ok: true, violation: null, base: parsed.base,
    env: { npm_config_registry: parsed.base, NPM_CONFIG_REGISTRY: parsed.base },
  };
}

/** 有界读取响应体；超限返回 null（调用方按「不可用」处理，不猜内容）。 */
async function readCapped(res, maxBytes) {
  const cl = Number(res.headers && res.headers.get('content-length')) || 0;
  if (cl > maxBytes) return null;
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength || value.length || 0;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* 已断 */ } return null; }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return buf.toString('utf8');
}

/** 取镜像内容的唯一传输口：`redirect:'manual'` + **逐跳复验** + 状态码/字节/时长三重有界。
 *  旧形状是反的 —— 探测阶段拒绝一切跳转（判死健康的 302 型镜像），取数据阶段却用默认策略
 *  盲从跳转到任意主机。统一到这里之后，探测与消费得到同一个答案。
 *  @param {string} startUrl @param {object} [opts] {timeoutMs,maxHops,maxBytes,expect:'json'|'none'} */
async function fetchRegistry(startUrl, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : MAX_BODY_BYTES;
  const maxHops = Number.isFinite(o.maxHops) ? o.maxHops : REDIRECT_MAX_HOPS;
  let url = String(startUrl || '');
  const hops = [];
  const fail = (status, error) => ({ ok: false, status, json: null, error, url, hops });
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    } catch (e) {
      return fail(null, (e && (e.name === 'TimeoutError' ? '超时' : e.message)) || String(e));
    }
    hops.push({ url, status: res.status });
    if (res.status >= 300 && res.status < 400) {
      try { if (res.body) await res.body.cancel(); } catch { /* 无体可取消 */ }
      if (hop >= maxHops) return fail(res.status, '跳转次数超过上限');
      const loc = res.headers.get('location');
      if (!loc) return fail(res.status, '跳转缺少 Location');
      let next;
      try { next = new URL(loc, url).toString(); } catch { return fail(res.status, '跳转目标无法解析'); }
      const tv = targetHostViolation(next, url);
      url = next;
      if (tv) return fail(res.status, tv);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      try { if (res.body) await res.body.cancel(); } catch { /* 无体可取消 */ }
      return fail(res.status, 'HTTP ' + res.status);
    }
    if (o.expect === 'none') {
      try { if (res.body) await res.body.cancel(); } catch { /* 无体可取消 */ }
      return { ok: true, status: res.status, json: null, error: null, url, hops };
    }
    // 读体阶段的中断（对端半路关连接、超时掐流）也必须落成结构化失败：本口是「可达」的唯一
    // 判据源，抛出去会让每个调用方各自长出一份 try —— 那正是探测与消费答案分叉的起点。
    let text;
    try {
      text = await readCapped(res, maxBytes);
    } catch (e) {
      return fail(res.status, '读取响应体中断：' + ((e && e.message) || String(e)));
    }
    if (text === null) return fail(res.status, '响应体超过上限');
    if (o.expect !== 'json') return { ok: true, status: res.status, json: null, text, error: null, url, hops };
    try {
      return { ok: true, status: res.status, json: JSON.parse(text), error: null, url, hops };
    } catch {
      return fail(res.status, '响应不是合法 JSON');
    }
  }
}

module.exports = {
  normalizeBase,
  hostViolation,
  parseRegistryBase,
  targetHostViolation,
  registryEnvPair,
  registryPackagePath,
  registryUrl,
  fetchRegistry,
};
