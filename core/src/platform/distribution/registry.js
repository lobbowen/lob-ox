'use strict';

const matrix = require('../contract/matrix');
const policies = require('./policies');
const ref = require('./registry-ref');
const config = require('./registry-config');

function platformTag() {
  return matrix.npmTag();
}



function registryOrigins(state) {
  const seen = new Set();
  const out = [];
  for (const raw of policies.effectiveOrigins(state.registryConfig, state.contract, state.defaultRegistries)) {
    const parsed = ref.parseRegistryBase(raw);
    const base = parsed.ok ? parsed.base : ref.normalizeBase(raw);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}


async function probeOrAdopt(state, origins) {
  const c = state.contract;
  if (c && c.ok) {
    const adopted = policies.shellProbeResults(origins, c.measurements, Math.floor(Date.now() / 1000));
    if (adopted) return adopted;
  }
  return (origins || []).map((origin) => ({ origin, ok: false, latencyMs: null, error: 'shell-contract 未提供测速结果（镜像源归壳侧底座）', from: 'no-contract' }));
}

function orderFor(primary, origins, results) {
  const usable = (o) => ref.parseRegistryBase(o).ok;
  const ranked = (results || []).filter((r) => r.ok).map((r) => r.origin);
  const ordered = [];
  for (const o of [primary, ...ranked, ...origins]) {
    if (!o || !usable(o)) continue;
    if (!ordered.includes(o)) ordered.push(o);
  }
  return ordered;
}

async function selectRegistry(state, force) {
  config.reloadContractIfStale(state);
  const rc = state.registryConfig || {};
  const origins = registryOrigins(state);
  const manualParsed = ref.parseRegistryBase(rc.manualOrigin);
  const manualBase = manualParsed.ok ? manualParsed.base : '';
  const manual = rc.mode === 'manual' && !!manualBase;

  const now = Date.now();
  const cached = state.selectedRegistry;
  if (!force && cached && cached.checkedAt && (now - cached.checkedAt) < 30 * 60 * 1000) {
    return cached;
  }
  const results = await probeOrAdopt(state, origins);
  const firstReachable = results.find((r) => r.ok);
  const fromShell = results.length > 0 && results.every((r) => r.from === 'shell-contract');
  const primary = manual ? manualBase : ((firstReachable && firstReachable.origin) || null);
  const selected = {
    origin: primary,
    ordered: orderFor(primary, origins, results),
    source: manual ? 'manual' : (firstReachable ? (fromShell ? 'shell-probe' : 'probe') : 'unreachable'),
    manual,
    checkedAt: firstReachable || manual ? now : null,
    latencyMs: (firstReachable && firstReachable.origin === primary) ? firstReachable.latencyMs : null,
    probes: results,
  };
  state.selectedRegistry = selected;
  if (state.events) {
    try {
      state.events.append(firstReachable || manual ? 'dist_registry_selected' : 'dist_registry_unreachable', {
        origin: primary,
        source: selected.source,
        candidates: results.map((r) => r.origin + ':' + (r.ok ? r.latencyMs + 'ms' : (r.error || '不可达'))),
      });
    } catch {  }
  }
  return selected;
}

async function registryOrigin(state, force) {
  const sel = await selectRegistry(state, force);
  return (sel && sel.origin) || null;
}

async function registryInfo(state) {
  config.reloadContractIfStale(state);
  const sel = await selectRegistry(state, false) || {};
  const rc = state.registryConfig || {};
  const c = state.contract;
  const verdictOf = (origin) => (sel.probes || []).find((p) => p.origin === origin) || null;
  return {
    origin: sel.origin || null,
    ordered: sel.ordered || [],
    source: sel.source || null,
    mode: rc.mode || 'auto',
    manualOrigin: rc.manualOrigin || '',
    candidates: registryOrigins(state).map((o) => ({ origin: o })),
    registries: registryOrigins(state).map((o) => {
      const parsed = ref.parseRegistryBase(o);
      const v = verdictOf(o);
      return {
        base: parsed.base,
        usable: parsed.ok,
        violation: parsed.violation,
        reachable: v ? v.ok : null,
        latencyMs: v ? v.latencyMs : null,
        error: v ? (v.error || null) : null,
      };
    }),
    presets: (c && c.ok) ? c.catalog : [],
    catalogSource: (c && c.ok) ? (c.writtenBy || 'shell') : 'fallback',
    contractSchema: (c && c.ok) ? c.schema : null,
    latencyMs: sel.latencyMs || null,
    checkedAt: sel.checkedAt || null,
    manual: !!sel.manual,
    probes: sel.probes || [],
  };
}

async function setRegistryConfig(state, cfg) {
  const rc = { ...(state.registryConfig || {}) };
  let rejected = [];
  if (cfg && typeof cfg === 'object') {
    if (cfg.mode === 'manual' || cfg.mode === 'auto') rc.mode = cfg.mode;
    if (typeof cfg.manualOrigin === 'string') {
      const mo = cfg.manualOrigin.trim();
      if (mo && rc.mode === 'manual') {
        const v = policies.registryOriginViolation(mo);
        if (v) {
          const info = await registryInfo(state);
          info.error = v;
          return info;
        }
      }
      rc.manualOrigin = mo;
    }
    if (Array.isArray(cfg.origins)) {
      const raw = cfg.origins.map((x) => String(x).trim());
      const reasons = new Map();
      const list = raw.filter((x) => {
        if (!x) return false;
        const v = policies.registryOriginViolation(x);
        if (v) { reasons.set(x, v); return false; }
        return true;
      });
      rejected = raw.filter((x) => x && reasons.has(x));
      if (list.length) rc.origins = list;
    }
  }
  state.registryConfig = rc;
  config.saveRegistryConfig(state);
  state.selectedRegistry = null;
  const info = await registryInfo(state);
  if (rejected.length) {
    if (state.logger && state.logger.warn) {
      state.logger.warn('[registry] 已忽略 ' + rejected.length + ' 个非法镜像源（需 http(s):// 前缀）：' +
        rejected.slice(0, 3).join(', ') + (rejected.length > 3 ? ' …' : ''));
    }
    info.rejectedOrigins = rejected;
  }
  return info;
}

const http = require('node:http');
const https = require('node:https');

function probeOriginHttp(origin, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(origin); } catch { return resolve({ ok: false, latencyMs: null, error: 'origin 非法' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.get(u, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, latencyMs: Date.now() - t0, status: res.statusCode });
    });
    req.setTimeout(Math.max(200, Number(timeoutMs) || 5000), () => {
      try { req.destroy(); } catch {}
      resolve({ ok: false, latencyMs: null, error: '超时' });
    });
    req.on('error', (e) => resolve({ ok: false, latencyMs: null, error: e.message }));
  });
}


// R3 / 攻击链 D：probe 路径此前完全不走 parseRegistryBase 校验，而
// setRegistryConfig（本文件后文）是有校验的——同一文件内两个入口强度不同。
// 后果：POST /dist/registry/probe 可让内核向 file://、127.0.0.1、169.254.169.254
// 发起 GET，而 probeOriginHttp 里 statusCode < 500 即判 ok，足以做内网端口扫描。
// 修为与 setRegistryConfig 同源：探测目标必须先过同一个 URL 准入判定。
function probeRegistry(state, origin, opts) {
  const o = opts || {};
  const parsed = ref.parseRegistryBase(origin);
  const hv = parsed.ok ? ref.hostViolation(parsed.host) : null;
  if (!parsed.ok || hv) {
    return Promise.resolve({ ok: false, latencyMs: null, error: '非法镜像源（' + (hv || parsed.violation) + '）', rejected: true });
  }
  return probeOriginHttp(parsed.base, o.timeoutMs);
}

function probeOrigin(state, origin, opts) {
  return probeRegistry(state, origin, opts);
}

module.exports = {
  platformTag,
  registryOrigins,
  orderFor,
  selectRegistry,
  registryOrigin,
  registryInfo,
  setRegistryConfig, probeOrigin, probeRegistry,
};
