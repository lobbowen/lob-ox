'use strict';

const matrix = require('../contract/matrix');
const policies = require('./policies');
const ref = require('./registry-ref');
const config = require('./registry-config');

const PROBE_MAX_BODY_BYTES = 8 * 1024 * 1024;

function platformTag() {
  return matrix.npmTag();
}

async function probeRegistry(state, origin) {
  const spec = (state.contract && state.contract.ok && state.contract.probe) || null;
  let tag = null;
  try {
    if (matrix.isSupported()) tag = platformTag();
  } catch { tag = null; }
  const target = policies.resolveProbe(origin, spec, tag);
  if (!target.url) {
    return { ok: false, latencyMs: 0, probe: target.kind, error: target.violation || '镜像基址非法' };
  }
  const start = Date.now();
  const r = await ref.fetchRegistry(target.url, {
    timeoutMs: target.timeoutMs, expect: 'text', maxBytes: PROBE_MAX_BODY_BYTES,
  });
  return { ok: !!r.ok, latencyMs: Date.now() - start, probe: target.kind, error: r.error || null };
}

async function probeOrigin(state, origin) {
  const parsed = ref.parseRegistryBase(origin);
  if (!parsed.ok) return { origin: ref.normalizeBase(origin), ok: false, latencyMs: null, error: parsed.violation };
  const p = await probeRegistry(state, parsed.base);
  return { origin: parsed.base, ok: !!p.ok, latencyMs: p.latencyMs, probe: p.probe, error: p.error || null };
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

async function probeAllOrigins(state, origins) {
  const results = await Promise.all(origins.map(async (origin) => {
    const p = await probeRegistry(state, origin);
    return { origin, ok: !!p.ok, latencyMs: p.latencyMs, error: p.error || null };
  }));
  results.sort((a, b) => (a.ok === b.ok ? a.latencyMs - b.latencyMs : (a.ok ? -1 : 1)));
  return results;
}

async function probeOrAdopt(state, origins) {
  const c = state.contract;
  if (c && c.ok) {
    const adopted = policies.shellProbeResults(origins, c.measurements, Math.floor(Date.now() / 1000));
    if (adopted) return adopted;
  }
  return probeAllOrigins(state, origins);
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

module.exports = {
  platformTag,
  probeRegistry,
  probeOrigin,
  probeAllOrigins,
  registryOrigins,
  orderFor,
  selectRegistry,
  registryOrigin,
  registryInfo,
  setRegistryConfig,
};
