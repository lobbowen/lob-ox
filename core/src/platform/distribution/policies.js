'use strict';

const registryRef = require('./registry-ref');

const NPM_TIMEOUT_MS = { install: 600000, uninstall: 900000 };

const FALLBACK_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

function registryOriginViolation(origin) {
  const parsed = registryRef.parseRegistryBase(origin);
  if (!parsed.ok) return parsed.violation;
  return registryRef.hostViolation(parsed.host);
}

function effectiveOrigins(registryConfig, contract, defaultRegistries) {
  const user = ((registryConfig && registryConfig.origins) || [])
    .filter((x) => typeof x === 'string' && x.trim());
  if (user.length) return user;
  const catalog = (contract && contract.ok && contract.catalog.length) ? contract.catalog : [];
  if (catalog.length) return catalog;
  return [...(defaultRegistries || [])];
}

function rebuildRegistryConfig(doc) {
  const d = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {};
  const origins = Array.isArray(d.origins) ? d.origins.filter((x) => typeof x === 'string' && x.trim()) : [];
  return {
    mode: d.mode === 'manual' ? 'manual' : 'auto',
    manualOrigin: typeof d.manualOrigin === 'string' ? d.manualOrigin.trim() : '',
    origins,
  };
}

function resolveProbe(origin, spec, platformTag) {
  const timeoutMs = (spec && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) ? spec.timeoutMs : 4000;
  const parsed = registryRef.parseRegistryBase(origin);
  if (!parsed.ok) return { url: null, kind: 'invalid', timeoutMs, violation: parsed.violation };
  if (spec && spec.kind === 'package-metadata' && spec.pathTemplate && platformTag) {
    return {
      url: registryRef.registryUrl(parsed.base, spec.pathTemplate.replace('{platform}', platformTag)),
      kind: spec.kind,
      timeoutMs,
    };
  }
  return { url: registryRef.registryUrl(parsed.base, '/-/ping'), kind: 'ping', timeoutMs };
}

function isInCanaryList(state) {
  return state.canary === true;
}

const SHELL_PROBE_MAX_AGE_SEC = 30 * 60;

function shellProbeResults(origins, measurements, nowSec, maxAgeSec) {
  if (!Array.isArray(measurements) || !measurements.length) return null;
  const ttl = Number.isFinite(maxAgeSec) ? maxAgeSec : SHELL_PROBE_MAX_AGE_SEC;
  const byBase = new Map();
  for (const m of measurements) {
    if (!m || typeof m.origin !== 'string') continue;
    const age = nowSec - Number(m.checkedAt);
    if (!(age >= 0) || age > ttl) continue;
    const parsed = registryRef.parseRegistryBase(m.origin);
    if (parsed.ok && !byBase.has(parsed.base)) byBase.set(parsed.base, m);
  }
  if (!byBase.size) return null;
  const results = [];
  for (const o of origins || []) {
    const parsed = registryRef.parseRegistryBase(o);
    if (!parsed.ok) return null;
    const m = byBase.get(parsed.base);
    if (!m) return null;
    results.push({
      origin: parsed.base,
      ok: m.ok === true,
      latencyMs: Number.isFinite(m.latencyMs) ? m.latencyMs : 0,
      error: m.error || null,
      from: 'shell-contract',
    });
  }
  if (!results.length) return null;
  results.sort((a, b) => (a.ok === b.ok ? a.latencyMs - b.latencyMs : (a.ok ? -1 : 1)));
  return results;
}

module.exports = {
  FALLBACK_REGISTRIES,
  NPM_TIMEOUT_MS,
  SHELL_PROBE_MAX_AGE_SEC,
  registryOriginViolation,
  effectiveOrigins,
  rebuildRegistryConfig,
  resolveProbe,
  shellProbeResults,
  isInCanaryList,
};
