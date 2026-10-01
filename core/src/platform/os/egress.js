'use strict';

const tls = require('node:tls');
const dns = require('node:dns');
const exec = require('../util/exec');
const registry = require('./registry');

const PROBE_TIMEOUT_MS = 2500;

const READ_TTL_MS = 60000;

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() || null; } catch { return null; }
}

// win32 系统代理只认 HKCU Internet Settings（唯一文档化位置）：ProxyEnable 是 DWORD，ProxyServer/AutoConfigURL 是字符串，三者缺一不能定有无代理。
// 三条查询必须异步：在 HTTP 路径上同步跑是最长 3 x 2.5s 的事件循环冻结。
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

function proxyLinux(env, note) {
  const pick = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  const server = pick('https_proxy') || pick('HTTPS_PROXY') || pick('http_proxy') || pick('HTTP_PROXY')
    || pick('ALL_PROXY') || pick('all_proxy');
  const noProxy = pick('no_proxy') || pick('NO_PROXY');
  const state = server ? 'on' : 'unknown';
  note('env proxy', 'state=' + state);
  return { state, server, pac: pick('PAC_FILE') || null, noProxy, source: 'env' };
}

function proxyUnknown(reason) {
  return { state: 'unknown', server: null, pac: null, source: reason };
}

const _proxyCache = new Map();

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

function proxyRead() {
  const hit = _proxyCache.get(process.platform);
  return hit ? hit.value : null;
}

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

function reachRead(host) {
  const h = String(host || '').toLowerCase();
  const hit = _reachCache.get(h);
  return hit ? hit.value : null;
}

function hosts() {
  return [..._reachCache.keys()];
}

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
