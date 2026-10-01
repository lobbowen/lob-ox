'use strict';

function createState(opts) {
  const o = opts || {};
  return {
    providers: [],
    running: false,
    stopped: false,
    ring: [],
    ringMax: 800,
    proxyUpdateCache: {},
    modelPriceIndex: null,
    providerServers: {},
    maintTimer: null,
    pricingTimer: null,
    lifecycleTimer: null,
    agentHttp: o.agentHttp || null,
    agentHttps: o.agentHttps || null,
    probeRunning: false,
    refreshRunning: false,
    lastProbeAt: 0,
    lastRefreshAt: 0,
    log(line) {
      this.ring.push(line);
      if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    },
  };
}

function findProvider(providers, id) { return (providers || []).find((p) => p.id === id) || null; }

function releaseProviderPorts(p, ports) {
  if (!p || !ports) return;
  try { ports.unregister('providerApi:' + p.id); } catch {}
  for (const i of (p.instances || [])) {
    if (i && i.keyId) { try { ports.unregister('proxy:' + i.keyId); } catch {} }
  }
}

function createOps(deps) {
  const d = deps || {};
  const state = d.state;
  const logger = d.logger || console;
  const events = d.events || null;
  const ports = d.ports;
  const endpoint = d.endpoint;
  const scheduler = d.scheduler;
  const createDirect = d.createDirect;
  const createProxy = d.createProxy;
  const apps = d.apps || {};
  const presets = d.presets || [];
  const save = d.save || (() => {});

  function addDirectProvider(opts) {
    const preset = (opts && opts.presetId) ? (presets.find((x) => x.id === opts.presetId) || null) : null;
    const baseUrl = (opts && opts.baseUrl) || (preset ? preset.baseUrl : '') || '';
    let existing = state.providers.find((p) => p.kind === 'direct' && p.baseUrl === baseUrl);
    if (!existing && preset) existing = state.providers.find((p) => p.kind === 'direct' && p.presetId === preset.id);
    if (existing) {
      for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !existing.accounts.some((a) => a.key === t)) existing.addAccount(t).then(() => save()).catch(() => {}); }
      save();
      return { ok: true, id: existing.id, already: true };
    }
    const p = createDirect({ id: 'prov-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: (opts && opts.name) || (preset ? preset.name : '供应商'), kind: 'direct', baseUrl, plan: preset ? { ...preset.plan } : null, pricing: preset ? { ...preset.pricing } : {}, adapter: preset ? preset.adapter : null, presetId: preset ? preset.id : null, logger, events, dist: d.dist, onPersist: save });
    state.providers.push(p);
    for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !p.accounts.some((a) => a.key === t)) p.addAccount(t).then(() => save()).catch(() => {}); }
    save();
    return { ok: true, id: p.id };
  }

  function addProxyProvider(opts) {
    const app = apps[opts && opts.appId];
    if (!app) return { ok: false, error: '未知反代应用 ' + (opts && opts.appId) };
    let p = state.providers.find((x) => x.kind === 'proxy' && x.proxyAppId === app.id);
    let created = false;
    if (!p) {
      p = createProxy({ id: 'prov-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: (opts && opts.name) || app.name, kind: 'proxy', proxyAppId: app.id, app, logger, events, dist: d.dist, onPersist: save });
      p.proxyRunning = true;
      state.providers.push(p);
      created = true;
    }
    for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !p.accounts.some((a) => a.key === t)) p.addAccount(t).then(() => save()).catch(() => {}); }
    save();
    return { ok: true, id: p.id, created, added: (opts && opts.keys) ? opts.keys.length : 0 };
  }

  function removeProvider(id) {
    const idx = state.providers.findIndex((p) => p.id === id);
    if (idx < 0) return { ok: false, error: '供应商不存在' };
    const removed = state.providers.splice(idx, 1)[0];
    endpoint.stopProviderServer(id);
    if (removed.supports('instanceLifecycle')) { for (const i of removed.instances || []) { try { removed.stopInstance(i, true); } catch {} } }
    try { releaseProviderPorts(removed, ports); } catch (e) { if (logger && logger.warn) logger.warn('release provider ports ' + id + ': ' + (e && e.message)); }
    save();
    return { ok: true };
  }

  function start() {
    if (state.running) return Promise.resolve({ ok: true, already: true });
    state.running = true;
    state.stopped = false;
    for (const p of state.providers) { if (p && p.supports('processPool')) p._stopping = false; }
    scheduler.start();
    return endpoint.startActivatedProviders().then(() => {
      if (events) events.append('router_started', { providers: state.providers.length });
      return { ok: true };
    }).catch((e) => ({ ok: false, error: e.message }));
  }

  function stopAll() {
    state.running = false;
    state.stopped = true;
    for (const p of state.providers) { if (p && p.supports('processPool')) p._stopping = true; }
    scheduler.stop();
    stopAllInstances();
    for (const id of Object.keys(state.providerServers)) endpoint.stopProviderServer(id);
    try { if (d.usage && typeof d.usage.flush === 'function') d.usage.flush(); } catch (e) { logger.warn && logger.warn('usage flush: ' + ((e && e.message) || e)); }
    if (events) events.append('router_stopped', {});
    return { ok: true };
  }

  function stop() { return stopAll(); }

  async function stopAndWait(timeoutMs) {
    stopAll();
    for (const p of state.providers) {
      if (p && p.supports('gracefulStop')) {
        try { await p.waitAllStopped(timeoutMs || 3000); } catch {}
      }
    }
    return { ok: true };
  }

  function stopAllInstances() {
    for (const p of state.providers) {
      if (!p.supports('instanceLifecycle')) continue;
      for (const i of (p.instances || [])) { try { p.stopInstance(i, true); } catch {} }
    }
  }

  return { addDirectProvider, addProxyProvider, removeProvider, start, stop, stopAndWait, stopAllInstances };
}

module.exports = { createState, createOps, findProvider };
