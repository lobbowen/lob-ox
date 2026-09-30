'use strict';

// 出网条件探测层（L0）：只回答两件事 —— 这台机器把地址交给外界时经过什么，以及某个域现在直不直得通。
//   不 launch、不选浏览器、不解释窗口结局（那是 ./browser.js 与 ./environment.js 的事）。
//
// 为什么外部打开链路需要这一层：一键登录开的是**冷档案隔离窗口**（独立 user-data-dir、无痕、无扩展、
//   无既有登录态）。「宿主浏览器打得开这个域」并不自动等于「冷档案也打得开」—— 差别正好落在
//   出网靠系统/环境代理还是靠档案里的东西（扩展、既有的 per-profile 配置）。缺这条事实时，
//   隔离窗口内容空白而产品只能说「已交出」，真机上就成了「弹了个看不懂的空白窗口」，谁也定不了性。
// 三端各写一处，读数一律三态：true 判过且成立 / false 判过且不成立 / null 无从判定。
//   把「读不到」折成 false 会让判据在 DNS 被污染的机器上凭空砍掉隔离能力，那是砍能力迁就缺陷；
//   反过来把超时折成 true 则会让空白窗口继续冒充「已交出」。超时与无应答一律 null。
// 本层只摸系统事实，不建表单：读数带 TTL 缓存，由 ./environment.js 的 egress 维度按拍取用并留痕。

const tls = require('node:tls');
const dns = require('node:dns');
const exec = require('../util/exec');
const registry = require('./registry');

/** 单次系统查询/通路判定的上界：与浏览器探测同口径，不得吃掉面板的动作预算。 */
const PROBE_TIMEOUT_MS = 2500;

/** 读数复用窗口：代理一改必须由 invalidate 显式作废，TTL 只是兜底，不是「按时间猜代理没变」。 */
const READ_TTL_MS = 60000;

/** 只取主机名：判据的对象是「这台机器到那个域有没有路」，与路径、查询串无关。 */
function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() || null; } catch { return null; }
}

/** win32 系统代理：HKCU 的 Internet Settings 是唯一文档化读取位置。ProxyEnable 是 DWORD、
 *  ProxyServer / AutoConfigURL 是字符串 —— 三者缺一不能定「有没有代理」：只配 PAC 时 ProxyEnable 也是 0，
 *  配了 ProxyServer 但 ProxyEnable=0 是「存着但没开」，那种机器上冷档案同样没有路。
 *  异步 runner（本层唯一口径）：这三条查询在 HTTP 路径上同步跑就是最长 3 x 2.5s 的事件循环冻结。 */
function proxyWin(runner, note) {
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const read = (args) => Promise.resolve(runner('reg.exe', args));
  return Promise.all([
    read(['query', KEY, '/v', 'ProxyEnable']),
    read(['query', KEY, '/v', 'ProxyServer']),
    read(['query', KEY, '/v', 'AutoConfigURL']),
  ]).then(([en, sv, pc]) => {
    const on = registry.regDwordOf(en);
    const server = registry.regValueOf(sv);
    const pac = registry.regValueOf(pc);
    const state = on === 1 ? 'on' : (on === 0 ? (pac ? 'on' : 'off') : 'unknown');
    note('registry:Internet Settings', 'ProxyEnable=' + (on === null ? 'unreadable' : on) + ' server=' + (server || '-') + ' pac=' + (pac ? 'set' : '-'));
    return { state, server: server || null, pac: pac || null, source: 'registry:Internet Settings' };
  });
}

/** darwin：`scutil --proxy` 是系统代理的文档化读取口（输出为 `Key : value` 行）。
 *  取不到输出即 unknown，不拿「没读到」当「没配」。 */
function proxyMac(runOut, note) {
  return Promise.resolve(runOut('scutil', ['--proxy'])).then((out) => {
    if (!out) {
      note('scutil --proxy', 'unreadable');
      return { state: 'unknown', server: null, pac: null, source: 'scutil' };
    }
    const kv = {};
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
      if (m) kv[m[1]] = m[2];
    }
    const flagOn = (k) => kv[k] === '1';
    const anyManual = kv.HTTPEnable !== undefined || kv.HTTPSEnable !== undefined || kv.SOCKSEnable !== undefined
      || kv.ProxyAutoConfigEnable !== undefined;
    const state = (flagOn('HTTPEnable') || flagOn('HTTPSEnable') || flagOn('SOCKSEnable') || flagOn('ProxyAutoConfigEnable'))
      ? 'on' : (anyManual ? 'off' : 'unknown');
    note('scutil --proxy', 'state=' + state);
    return {
      state,
      server: kv.HTTPProxy || kv.HTTPSProxy || kv.SOCKSProxy || null,
      pac: kv.ProxyAutoConfigURLString || kv.ProxyAutoConfigURL || null,
      source: 'scutil',
    };
  });
}

/** linux：环境变量是唯一文档化口径（大小写都认）。一个都没导出 = unknown 而不是 off：
 *  systemd/服务语境本就 import-environment 不全，判成「没配」会把有代理的机器说成没代理。 */
function proxyLinux(env, note) {
  const pick = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  const server = pick('https_proxy') || pick('HTTPS_PROXY') || pick('http_proxy') || pick('HTTP_PROXY')
    || pick('ALL_PROXY') || pick('all_proxy');
  const noProxy = pick('no_proxy') || pick('NO_PROXY');
  const state = server ? 'on' : 'unknown';
  note('env proxy', 'state=' + state);
  return { state, server, pac: pick('PAC_FILE') || null, noProxy, source: 'env' };
}

/** 未知平台与抛错一律 unknown：本层不得替任何平台猜一个「没代理」。 */
function proxyUnknown(reason) {
  return { state: 'unknown', server: null, pac: null, source: reason };
}

const _proxyCache = new Map();

/** 系统代理读数（异步口径：会起 reg.exe / scutil 子进程，HTTP 路径与启动装配只走这条）。
 *  @param {{platform?:string, runOut?:Function, env?:object, force?:boolean, ttlMs?:number, now?:Function}} [o]
 *  @returns {Promise<{platform,state,server,pac,source,at,cached?,probed:object[]}>} */
function proxy(o) {
  const ov = o || {};
  const pl = ov.platform || process.platform;
  const now = typeof ov.now === 'function' ? ov.now : Date.now;
  const ttl = ov.ttlMs === undefined ? READ_TTL_MS : ov.ttlMs;
  const hit = _proxyCache.get(pl);
  if (!ov.force && ttl > 0 && hit && now() - hit.value.at < ttl) {
    return Promise.resolve(Object.assign({}, hit.value, { cached: true }));
  }
  const notes = [];
  const note = (source, detail) => { notes.push({ source, detail }); };
  const runOut = ov.runOut || ((bin, args) => exec.runOutAsync(bin, args, { timeoutMs: PROBE_TIMEOUT_MS }));
  const out = Promise.resolve()
    .then(() => {
      if (pl === 'win32') return proxyWin(runOut, note);
      if (pl === 'darwin') return proxyMac(runOut, note);
      if (pl === 'linux') return proxyLinux(ov.env || process.env, note);
      return proxyUnknown('unsupported-platform');
    })
    .catch((e) => {
      note(pl + ' proxy probe', 'error: ' + String((e && (e.code || e.message)) || e));
      return proxyUnknown('probe-failed');
    })
    .then((v) => {
      const value = Object.assign({ platform: pl, at: now(), probed: notes }, v);
      _proxyCache.set(pl, { value });
      return value;
    });
  return out;
}

/** 已读到的系统代理读数（同步取，绝不在此起子进程）：从未探过即 null，由调用方标成 unknown。 */
function proxyRead() {
  const hit = _proxyCache.get(process.platform);
  return hit ? hit.value : null;
}

/** 一次通路判定：DNS 解析 -> TLS 握手（带 SNI）依次留痕。
 *  判据停在 TLS 完成，不发业务请求：那是「浏览器能不能渲染这个站」的最低充分事实，
 *  而取内容属于消费方，探测顺手 GET 页面会把能力判定变成内容依赖。
 *  ok 三态的分工写死在这里：明确否定（NXDOMAIN / 连接被拒 / TLS 报错）才是 false，
 *  没有答案（解析服务器不响应、连接超时）一律 null —— null 不支撑任何砍能力的结论。 */
function reachWith(deps, host, port, timeoutMs) {
  const d = deps || {};
  const ms = timeoutMs || PROBE_TIMEOUT_MS;
  const lookup = d.lookup || ((h) => new Promise((resolve, reject) => dns.lookup(h, (err, addr) => (err ? reject(err) : resolve(addr)))));
  const connect = d.connect || ((opts) => new Promise((resolve, reject) => {
    let settled = false;
    const sock = tls.connect(opts);
    const fail = (e) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} reject(e); };
    sock.once('secureConnect', () => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve(true); });
    sock.once('error', fail);
    sock.setTimeout(ms, () => fail(Object.assign(new Error('tls-timeout'), { code: 'ETIMEDOUT' })));
  }));
  const started = Date.now();
  const verdict = (ok, stage, detail) => ({ ok, stage, host, port, detail, at: started });
  return lookup(host)
    .then((addr) => connect({ host: addr, port, servername: host, timeout: ms }))
    .then(() => verdict(true, 'tls', 'TLS 握手完成'))
    .catch((e) => {
      const code = String((e && (e.code || e.message)) || e);
      if (/ENOTFOUND/i.test(code)) return verdict(false, 'dns', code);
      if (/ECONNREFUSED/i.test(code)) return verdict(false, 'tcp', code);
      if (/EPROTO|handshake|ALPR|CERT|UNEXPECTED/i.test(code)) return verdict(false, 'tls', code);
      if (/EAI_AGAIN|getaddrinfo|ESERVFAIL|ENODATA/i.test(code)) return verdict(null, 'dns', code);
      if (/ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|timeout/i.test(code)) return verdict(null, 'tcp', code);
      return verdict(null, 'tcp', code);
    });
}

const _reachCache = new Map();

/** 带复用的通路判定：同一主机在 TTL 内不重复摸网。`force` 与 invalidate 是仅有的两条重探路。
 *  @param {{lookup?:Function, connect?:Function, now?:Function, timeoutMs?:number, force?:boolean,
 *           ttlMs?:number, port?:number}} [o] */
function reach(host, o) {
  const ov = o || {};
  const h = String(host || '').toLowerCase();
  if (!h) return Promise.resolve({ ok: null, stage: 'not-attempted', host: host || null, port: null, detail: '没有可判定的主机', at: Date.now() });
  const ttl = ov.ttlMs === undefined ? READ_TTL_MS : ov.ttlMs;
  const hit = _reachCache.get(h);
  if (!ov.force && ttl > 0 && hit && Date.now() - hit.value.at < ttl) {
    return Promise.resolve(Object.assign({}, hit.value, { cached: true }));
  }
  const port = ov.port || 443;
  return reachWith(ov, h, port, ov.timeoutMs).then((v) => {
    _reachCache.set(h, { value: v });
    return v;
  });
}

/** 已读到的通路判定（同步取，绝不在这里发网络请求）：冷档案判据只念这一份。 */
function reachRead(host) {
  const h = String(host || '').toLowerCase();
  const hit = _reachCache.get(h);
  return hit ? hit.value : null;
}

/** 本层已知的目标主机（按探测先后去重）：快照与面板据此说明「这张表对哪些域判过路」。 */
function hosts() {
  return [..._reachCache.keys()];
}

/** 作废读数：代理一改，旧判定必须当场失效而不是等 TTL。未传参即全清。 */
function invalidate(host) {
  if (host === undefined || host === null) {
    const n = _reachCache.size + _proxyCache.size;
    _reachCache.clear();
    _proxyCache.clear();
    return n;
  }
  return _reachCache.delete(String(host).toLowerCase()) ? 1 : 0;
}

module.exports = {
  PROBE_TIMEOUT_MS, READ_TTL_MS, hostOf,
  proxy, proxyRead, proxyWin, proxyMac, proxyLinux,
  reach, reachRead, reachWith, hosts, invalidate,
};
