'use strict';

const runtime = require('../contract/runtime');
const SHARED = require('../../shared/shared-constants');

const ex = require('../util/exec');
const BRAND = require('../../shared/brand');

function whichVersion(bin, args) {
  const v = ex.runOut(bin, (Array.isArray(args) ? args : []).concat(['--version']), { timeoutMs: 3000 });
  return v ? (v.trim() || null) : null;
}

function whichVersionAsync(bin, args) {
  return ex.runOutAsync(bin, (Array.isArray(args) ? args : []).concat(['--version']), { timeoutMs: 3000 })
    .then((v) => (v ? (v.trim() || null) : null));
}

const _verCache = new Map();
const CACHE_TTL = 10000;
function cacheKey(bin, args) {
  const a = Array.isArray(args) ? args : [];
  return bin + '\u0000' + a.join('\u0000');
}
function cacheSet(key, v) {
  _verCache.set(key, { at: Date.now(), v });
  if (_verCache.size > 16) {
    let oldest = null;
    for (const [k, e] of _verCache) if (!oldest || e.at < oldest.at) oldest = { k, at: e.at };
    if (oldest) _verCache.delete(oldest.k);
  }
  return v;
}
function cachedWhichVersion(bin, args) {
  const key = cacheKey(bin, args);
  const hit = _verCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL) return hit.v;
  return cacheSet(key, whichVersion(bin, args));
}
function cachedWhichVersionAsync(bin, args) {
  const key = cacheKey(bin, args);
  const hit = _verCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit.v);
  return whichVersionAsync(bin, args).then((v) => cacheSet(key, v));
}

// 与壳侧同源（决策 D4）：两侧都从 shared-constants.json 取，不再各存一份。
const MIN_NODE_DEFAULT = SHARED.runtime.minNode;

let _runtimeMetaCache = null;
let _runtimeMetaAt = 0;
function runtimeMeta() {
  const now = Date.now();
  if (_runtimeMetaCache && now - _runtimeMetaAt < 10000) return _runtimeMetaCache;
  const c = runtime.read();
  const meta = (c && c.raw) || {};
  _runtimeMetaCache = meta;
  _runtimeMetaAt = now;
  return meta;
}

function parseVer(v) {
  return String(v).replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
}

function verAtLeast(a, b) {
  const A = parseVer(a); const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0; const y = B[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

function nodeVerdict(v) {
  if (!v) return null;
  const m = /v?(\d+\.\d+\.\d+)/.exec(String(v));
  const ver = m ? m[1] : String(v).trim();
  const min = String(runtimeMeta().minNode || MIN_NODE_DEFAULT);
  return { version: 'v' + ver, min, meets: verAtLeast(ver, min) };
}
function probeNode() {
  return nodeVerdict(cachedWhichVersion('node'));
}
function probeNodeAsync() {
  return cachedWhichVersionAsync('node').then(nodeVerdict);
}

function probeNpm() {
  const l = runtime.npmLauncher();
  return cachedWhichVersion(l.program, l.args);
}
function probeNpmAsync() {
  const l = runtime.npmLauncher();
  return cachedWhichVersionAsync(l.program, l.args);
}

const SYSTEM_ENTRIES = {
  node: { label: 'Node.js', required: true, probe: probeNode, probeAsync: probeNodeAsync },
  npm:  { label: 'npm',     required: true, probe: probeNpm, probeAsync: probeNpmAsync },
  git:  { label: 'git',     required: false, probe: () => cachedWhichVersion('git'), probeAsync: () => cachedWhichVersionAsync('git') },
};

function entryView(id, e, v) {
  if (v && typeof v === 'object' && typeof v.meets === 'boolean') {
    return {
      label: e.label, required: e.required,
      state: v.meets ? 'ok' : 'outdated',
      version: v.version, min: v.min, meets: v.meets,
      detail: v.meets ? v.version : (v.version + '（低于最低要求 ' + v.min + '）'),
    };
  }
  return { label: e.label, required: e.required, state: v ? 'ok' : 'missing', detail: v };
}

class EnvCatalog {
  constructor(config) { this.config = config || {}; }

  probe() {
    const out = {};
    for (const [id, e] of Object.entries(SYSTEM_ENTRIES)) {
      out[id] = entryView(id, e, e.probe() || null);
    }
    return out;
  }

  async probeAsync() {
    const entries = Object.entries(SYSTEM_ENTRIES);
    const vals = await Promise.all(entries.map(([, e]) => e.probeAsync()));
    const out = {};
    entries.forEach(([id, e], i) => { out[id] = entryView(id, e, vals[i] || null); });
    return out;
  }

  selfUpdateEntry() {
    const pkg = this.config.corePackageName;
    if (!pkg) {
      return {
        label: '内核更新（桌面壳执行）',
        required: false,
        state: 'unconfigured',
        detail: '未配置 corePackageName（形如 ' + BRAND.corePackageName('<os>-<arch>') + '）',
      };
    }
    return { label: '内核更新（桌面壳执行）', required: false, state: 'configured', detail: pkg };
  }

  dshEntry(binOk, installed, bin) {
    return {
      label: 'DSH 本体',
      required: true,
      state: binOk ? 'ok' : 'missing',
      detail: binOk ? (installed || '已装') : ('bin 不存在: ' + (bin || '?')),
    };
  }

  summary(extra, sys) {
    const s = sys || this.probe();
    const items = { ...s, ...(extra || {}) };
    const required = Object.values(items).filter((e) => e && e.required);
    return { ready: required.every((e) => e.state === 'ok' || e.state === 'configured'), items };
  }
}

module.exports = { EnvCatalog };
