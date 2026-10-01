'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stateRoot = require('../service/state-root');
const { writeAtomic } = require('../util/fs');
const { maskProxyServer, maskProxySecrets } = require('../util/redact');
const desktop = require('./desktop');
const detector = require('./browser-inventory');
const egress = require('./egress');
const shellReport = require('../contract/shell-report');
const { engineOf } = detector;

const SCHEMA = 2;

const FILE_NAME = 'environment.json';

const FORM_TTL_MS = 60000;

const SECTION_TTL_MS = 60000;

const SHELL_REPORT_TTL_MS = 10000;

let _sources = {};

function bind(sources) {
  _sources = Object.assign({}, _sources, sources || {});
  return _sources;
}

function preferenceId() {
  const f = _sources.preference;
  if (typeof f !== 'function') return null;
  const v = f();
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function capabilities() {
  const f = _sources.capabilities;
  if (typeof f !== 'function') return null;
  return f() || null;
}

function identity() {
  let user = null;
  try { user = os.userInfo().username; } catch { user = process.env.USER || process.env.USERNAME || null; }
  return {
    platform: process.platform, arch: process.arch,
    hostname: os.hostname(), user: user || null, home: os.homedir(), node: process.version,
  };
}

function paths() {
  return { root: stateRoot.root(), supervisor: stateRoot.supervisorDir(), shell: stateRoot.shellDir() };
}

function normalizeInventory(inv, platform) {
  const list = inv && Array.isArray(inv.browsers) ? inv.browsers : [];
  const defaultId = inv && inv.defaultId ? inv.defaultId : null;
  return {
    platform: (inv && inv.platform) || platform || process.platform,
    cached: !!(inv && inv.cached),
    at: inv && inv.at !== undefined ? inv.at : null,
    defaultId,
    defaultSource: (inv && inv.defaultSource) || null,
    browsers: list.map((b) => ({
      id: b.id,
      name: b.name,
      bin: b.bin,
      engine: b.engine || engineOf(b.bin),
      baseArgs: b.baseArgs || [],
      sources: b.sources && b.sources.length ? b.sources : [b.source || 'unknown'],
      isDefault: !!defaultId && b.id === defaultId,
    })),
    probed: (inv && inv.probed) || [],
  };
}

function browsers(o) {
  const ov = o || {};
  const pl = ov.platform || process.platform;
  if (ov.inventory) return normalizeInventory(ov.inventory, pl);
  const resolve = typeof ov.resolveInventory === 'function' ? ov.resolveInventory
    : ((platform, deps) => detector.inventory(platform, deps));
  return normalizeInventory(resolve(pl, ov.resolveDeps || {}), pl);
}

const ENGINE_RANK = { chromium: 0, firefox: 1, other: 2 };
function rankCandidates(list) {
  const rankOf = (b) => {
    const r = ENGINE_RANK[b && b.engine];
    return r === undefined ? ENGINE_RANK.other : r;
  };
  return (Array.isArray(list) ? list : []).slice().sort((a, b) => {
    if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    const ia = String((a && a.id) || '');
    const ib = String((b && b.id) || '');
    return ia < ib ? -1 : (ia > ib ? 1 : 0);
  });
}

function pickLauncher(platform, inv, preference) {
  const list = inv && Array.isArray(inv.browsers) ? inv.browsers : [];
  const byId = new Map();
  for (const b of list) byId.set(b.id, b);
  const wanted = preference === undefined ? preferenceId()
    : (typeof preference === 'string' && preference ? preference : null);
  const stale = wanted !== null && !byId.has(wanted);
  const out = (browser, how) => ({ browser, how, wanted, stale });
  if (wanted !== null && byId.has(wanted)) return out(byId.get(wanted), 'user-preference');
  const sys = inv && inv.defaultId ? byId.get(inv.defaultId) : null;
  if (sys) return out(sys, inv.defaultSource || 'default');
  if (list.length === 1) return out(list[0], 'only-installed');
  if (list.length > 1) return out(rankCandidates(list)[0], 'candidate-rank');
  return out(null, 'none-found');
}

const _sections = new Map();
const _reads = new Map();

const SECTION_ORDER = ['runtime', 'shell', 'dsh', 'browsers', 'session', 'egress', 'capabilities', 'preference', 'pick', 'startup'];

const SYNC_DIMS = ['browsers', 'session', 'capabilities', 'preference', 'pick'];

function registerSection(id, def) {
  if (!id || !def || typeof def.probe !== 'function') throw new Error('registerSection(' + id + ') 需要 probe 函数');
  if (SYNC_DIMS.includes(id)) throw new Error('维度 ' + id + ' 由表单每拍自装，不接注册');
  const d = { id, label: def.label || id, probe: def.probe, ttlMs: def.ttlMs === undefined ? SECTION_TTL_MS : def.ttlMs, source: def.source || 'registered' };
  _sections.set(id, d);
  _reads.delete(id);
  return d;
}

function unregisterSection(id) {
  _sections.delete(id);
  _reads.delete(id);
}

function section(id) {
  return _reads.get(id) || null;
}

function sectionData(id) {
  const r = _reads.get(id);
  return r ? r.data || null : null;
}

function proxyDataOf(p) {
  return p ? { state: p.state, server: maskProxyServer(p.server), pac: p.pac || null, source: p.source, cached: p.cached === true } : null;
}
function egressData(proxyReading) {
  const targets = {};
  for (const h of egress.hosts()) {
    const r = egress.reachRead(h);
    if (r) targets[h] = { ok: r.ok === null ? null : r.ok === true, stage: r.stage, detail: r.detail, at: r.at };
  }
  const p = proxyReading || egress.proxyRead();
  const probed = [];
  if (p) {
    for (const row of (p.probed || [])) probed.push({ source: row.source, detail: maskProxySecrets(String(row.detail || '')) });
    probed.push({ source: p.source, detail: 'proxy=' + p.state + (p.server ? ' (' + maskProxyServer(p.server) + ')' : '') + (p.cached ? ' 复用' : '') });
  } else {
    probed.push({ source: 'egress', detail: '系统代理未读（本维度尚未刷新）' });
  }
  for (const h of Object.keys(targets)) {
    const t = targets[h];
    probed.push({ source: 'reach:' + h, detail: (t.ok === null ? 'unknown' : (t.ok ? 'ok' : 'no-route')) + '@' + t.stage + ' ' + t.detail });
  }
  return {
    at: p ? p.at : null,
    proxy: proxyDataOf(p),
    targets,
    probed,
  };
}

registerSection('egress', {
  label: '出网条件',
  source: 'self',
  probe: (o) => {
    const ov = o || {};
    const force = ov.force === true;
    const hosts = Array.isArray(ov.hosts) ? ov.hosts : egress.hosts();
    const reachOpts = { force, timeoutMs: ov.timeoutMs, lookup: ov.lookup, connect: ov.connect, ttlMs: ov.ttlMs };
    return Promise.all([egress.proxy(Object.assign({}, ov, { force }))]
      .concat(hosts.map((h) => egress.reach(h, reachOpts))))
      .then(([p]) => egressData(p));
  },
});

registerSection('shell', {
  label: '桌面壳所见（Node/npm/镜像源/全局前缀）',
  source: 'shell',
  ttlMs: SHELL_REPORT_TTL_MS,
  probe: () => shellReport.read(),
});

async function probeSection(id, o) {
  const def = _sections.get(id);
  if (!def) return null;
  const ov = o || {};
  const now = typeof ov.now === 'function' ? ov.now : Date.now;
  try {
    const data = await def.probe(ov);
    _reads.set(id, { at: now(), source: def.source, label: def.label, state: data ? 'ok' : 'empty', data: data || null, error: null });
  } catch (e) {
    _reads.set(id, { at: now(), source: def.source, label: def.label, state: 'error', data: null, error: String((e && (e.code || e.message)) || e) });
  }
  return _reads.get(id);
}

function staleOf(id, now, force) {
  if (force) return true;
  const def = _sections.get(id);
  const read = _reads.get(id);
  if (!def || !read) return true;
  return now - read.at >= def.ttlMs;
}

async function refresh(o) {
  const ov = o || {};
  const now = typeof ov.now === 'function' ? ov.now : Date.now;
  const ids = Array.isArray(ov.only) && ov.only.length ? ov.only : [..._sections.keys()];
  await Promise.all(ids.filter((id) => _sections.has(id) && staleOf(id, now(), ov.force))
    .map((id) => probeSection(id, ov)));
  return form(Object.assign({}, ov, { force: true }));
}

async function checkEgress(url, o) {
  const ov = o || {};
  const host = egress.hostOf(url);
  let data = ov.egress === undefined ? null : ov.egress;
  if (!data) {
    try {
      const hosts = new Set(egress.hosts());
      if (host) { await egress.reach(host, ov); hosts.add(host); }
      const read = await probeSection('egress', Object.assign({}, ov, { hosts: [...hosts] }));
      data = (read && read.data) || sectionData('egress');
    } catch { data = sectionData('egress'); }
  }
  const v = coldProfileViable(data, host);
  return Object.assign({}, v, {
    host,
    proxy: data && data.proxy ? data.proxy.state : 'unknown',
    at: data ? data.at || null : null,
  });
}

function coldProfileViable(eg, host) {
  if (!eg) return { viable: null, basis: 'egress-unprobed', detail: '出网条件尚未探测，隔离窗口按原档打开' };
  const t = host && eg.targets ? eg.targets[host] : null;
  const reached = t ? t.ok : null;
  const proxyState = eg.proxy ? eg.proxy.state : 'unknown';
  if (reached === true) {
    return { viable: true, basis: 'target-reachable', detail: host + ' 直连可达（' + t.stage + '）' };
  }
  if (reached === null) {
    return { viable: null, basis: 'egress-undetermined', detail: host + ' 的通路判定没有给出答案（' + (t ? t.stage + ' ' + t.detail : '无读数') + '）' };
  }
  if (proxyState === 'on') {
    return { viable: true, basis: 'cold-profile-inherits-proxy', detail: host + ' 直连不通（' + t.stage + '），系统级代理在用，冷档案同一条路' };
  }
  if (proxyState === 'unknown') {
    return { viable: null, basis: 'proxy-unreadable', detail: host + ' 直连不通（' + t.stage + '），但代理读数取不到，按判不出处理' };
  }
  return {
    viable: false, basis: 'cold-profile-blocked',
    detail: host + ' 直连不通（' + t.stage + ' ' + t.detail + '）且系统没有在用代理，冷档案窗口必然空白',
  };
}

function snapshotPath() {
  return path.join(stateRoot.supervisorDir(), FILE_NAME);
}

function readSnapshot() {
  try {
    const doc = JSON.parse(fs.readFileSync(snapshotPath(), 'utf8'));
    return doc && doc.schema === SCHEMA ? doc : null;
  } catch { return null; }
}

function lastSnapshot(o) {
  const now = (o && typeof o.now === 'function') ? o.now : Date.now;
  const p = snapshotPath();
  const doc = readSnapshot();
  if (doc) {
    const at = typeof doc.at === 'number' ? doc.at : null;
    return { available: true, path: p, at, ageMs: at === null ? null : Math.max(0, now() - at), reason: 'ok', data: doc };
  }
  return { available: false, path: p, at: null, ageMs: null,
    reason: fs.existsSync(p) ? 'unreadable-or-schema-mismatch' : 'never-written', data: null };
}

let _formCache = null;

function form(o) {
  const ov = o || {};
  const now = typeof ov.now === 'function' ? ov.now : (() => Date.now());
  const stamp = now();
  const ttl = ov.ttlMs === undefined ? FORM_TTL_MS : ov.ttlMs;
  if (!ov.force && _formCache && stamp - _formCache.at < ttl) {
    return Object.assign({}, _formCache.value, { cached: true });
  }
  const inv = browsers(ov);
  const caps = capabilities();
  const session = desktop.describe();
  const prefId = preferenceId();
  const prefEntry = prefId ? (inv.browsers.find((b) => b.id === prefId) || null) : null;
  const preference = {
    id: prefId,
    configured: !!prefId,
    matched: !!prefEntry,
    browser: prefEntry ? { id: prefEntry.id, name: prefEntry.name, engine: prefEntry.engine } : null,
    reason: !prefId ? 'not-set' : (prefEntry ? 'matched' : 'stale'),
  };
  const pick = pickLauncher(inv.platform, inv, prefId);
  const probed = inv.probed.map((p) => ({ section: 'browsers', source: p.source, detail: p.detail }));
  probed.push({ section: 'session', source: 'desktop', detail: session.reason + (session.available ? '（可用）' : '（不可用）') });
  probed.push({ section: 'capabilities', source: 'profile',
    detail: caps ? 'openBrowser=' + (caps.openBrowser === true) : '未绑定能力矩阵（由 platform/os/index.js 装配期注入）' });
  probed.push({ section: 'preference', source: 'config',
    detail: preference.reason === 'not-set' ? '未设置，按系统默认或候选次序分发'
      : (preference.reason === 'matched' ? '已选 ' + preference.browser.name : '偏好所指已不在候选清单: ' + prefId) });
  probed.push({ section: 'pick', source: 'form',
    detail: pick.how + (pick.browser ? '（' + pick.browser.name + '）' : '（无候选）') + (pick.stale ? '，偏好已失效需重选' : '') });

  const sections = {};
  const syncDims = {
    browsers: { at: stamp, state: inv.browsers.length ? 'ok' : 'empty', count: inv.browsers.length, defaultSource: inv.defaultSource },
    session: { at: stamp, state: session.available ? 'ok' : 'missing', reason: session.reason },
    capabilities: { at: stamp, state: caps ? 'ok' : 'unbound', openBrowser: caps ? caps.openBrowser === true : null },
    preference: { at: stamp, state: preference.reason === 'matched' ? 'ok' : (preference.configured ? 'stale' : 'unset'), id: preference.id },
    pick: { at: stamp, state: pick.browser ? 'ok' : 'empty', how: pick.how, id: pick.browser ? pick.browser.id : null },
  };
  const dimOf = (id) => {
    const def = _sections.get(id);
    const read = _reads.get(id);
    if (read && !syncDims[id]) {
      return { label: def ? def.label : id, at: read.at, source: read.source, state: read.state, data: read.data, error: read.error || null };
    }
    const s = syncDims[id];
    if (s) return Object.assign({ label: id, source: 'self' }, s);
    return { label: def ? def.label : id, at: null, source: def ? def.source : 'registered', state: 'pending', data: null, error: null };
  };
  const ids = SECTION_ORDER.concat([..._sections.keys()].filter((id) => !SECTION_ORDER.includes(id)));
  for (const id of ids) {
    if (sections[id]) continue;
    const entry = dimOf(id);
    sections[id] = entry;
    if (entry.state === 'pending') {
      probed.push({ section: id, source: 'form', detail: '未刷新（等启动装配或面板 force 刷新补拍）' });
    } else if (entry.state === 'error') {
      probed.push({ section: id, source: 'probe', detail: id + ' 探测失败: ' + entry.error });
    }
  }
  const egressRows = ((sections.egress || {}).data || {}).probed || [];
  for (const row of egressRows) probed.push({ section: 'egress', source: row.source, detail: row.detail });
  const sh = (sections.shell || {}).data;
  if (sh) {
    probed.push({
      section: 'shell',
      source: 'shell-report:' + (sh.reason || '?'),
      detail: sh.available === true
        ? '壳已上报（写入者 ' + (sh.writtenBy || '未署名') + '，schema ' + sh.schema
          + '，距今 ' + (sh.ageMs === null ? '未读出' : sh.ageMs) + ' 毫秒，明细 ' + (sh.records || []).length + ' 条'
          + (sh.droppedRecords ? '，截断 ' + sh.droppedRecords + ' 条' : '') + '）'
        : (sh.reason === 'never-written' ? '这台机器的壳还没报过（内核独立跑或老版本壳时是常态，不是故障）'
          : '壳报的文件读不出或版本不符，得查：' + (sh.path || '?')),
    });
  }

  const value = {
    schema: SCHEMA,
    at: stamp,
    platform: inv.platform,
    identity: identity(),
    paths: paths(),
    session,
    capabilities: caps,
    preference,
    default: inv.defaultId ? { id: inv.defaultId, source: inv.defaultSource } : null,
    browsers: inv.browsers,
    pick: { how: pick.how, id: pick.browser ? pick.browser.id : null, name: pick.browser ? pick.browser.name : null, wanted: pick.wanted, stale: pick.stale },
    sections,
    probed,
  };
  const snapshot = { path: snapshotPath(), written: false, error: null };
  if (ov.persist === true) {
    try {
      writeAtomic(snapshot.path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      snapshot.written = true;
    } catch (e) { snapshot.error = String((e && e.message) || e); }
    probed.push({ section: 'snapshot', source: FILE_NAME,
      detail: snapshot.written ? '已落盘 ' + snapshot.path : '落盘失败: ' + snapshot.error });
  }
  value.snapshot = snapshot;
  _formCache = { at: stamp, value };
  return Object.assign({ cached: false }, value);
}

function invalidate(platform, only) {
  _formCache = null;
  const list = only === undefined ? null : (Array.isArray(only) ? only : [only]);
  if (!list || list.includes('egress')) egress.invalidate();
  for (const id of (list || [..._reads.keys()])) {
    const r = _reads.get(id);
    if (r) r.at = 0;
  }
  return detector.invalidate(platform);
}

function checkPreference(value, form) {
  const candidates = ((form && form.browsers) || []).map((b) => ({
    id: b.id, name: b.name, engine: b.engine, isDefault: b.isDefault === true,
  }));
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) return { ok: true, id: null, browser: null, candidates };
  const hit = candidates.find((c) => c.id === id);
  if (!hit) {
    return { ok: false, id: null, browser: null, candidates, error: '该浏览器不在本机候选清单里（可能已卸载或路径失效），请先刷新环境表单' };
  }
  return { ok: true, id: hit.id, browser: hit, candidates };
}

module.exports = {
  SCHEMA, FILE_NAME, FORM_TTL_MS, SECTION_TTL_MS, SECTION_ORDER, SYNC_DIMS,
  bind, preferenceId, capabilities, identity, paths,
  browsers, normalizeInventory, rankCandidates, pickLauncher, checkPreference,
  registerSection, unregisterSection, section, sectionData, refresh,
  coldProfileViable, checkEgress,
  form, snapshotPath, readSnapshot, lastSnapshot, invalidate,
};
