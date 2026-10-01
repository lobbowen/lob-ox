'use strict';

function hasImminentReset(providers, now) {
  const horizon = (now || Date.now()) + 5 * 60 * 1000;
  for (const p of providers || []) {
    for (const a of (p.accounts || [])) {
      if (a.status === 'frozen' && a.nextResetAt && a.nextResetAt <= horizon) return true;
      if (a.status === 'frozen' && !a.nextResetAt) return true;
    }
  }
  return false;
}

function hasOverdueReset(providers, now) {
  const t = now || Date.now();
  for (const p of providers || []) {
    for (const a of (p.accounts || [])) {
      if (a.status === 'frozen' && a.nextResetAt && a.nextResetAt <= t) return true;
      if (a.status === 'frozen' && !a.nextResetAt) return true;
    }
  }
  return false;
}

function createScheduler(deps) {
  const d = deps || {};
  const state = d.state;
  const logger = d.logger || null;
  const refreshProxyUpdateInfo = d.refreshProxyUpdateInfo || (() => Promise.resolve());
  const refreshOfficialUsageAll = d.refreshOfficialUsageAll || (() => Promise.resolve());
  const refreshOfficialPricingAll = d.refreshOfficialPricingAll || (() => Promise.resolve());
  const now = d.now || (() => Date.now());
  const providers = () => state.providers || [];

  function start() {
    refreshProxyUpdateInfo().catch(() => {});
    refreshOfficialUsageAll().catch(() => {});
    refreshOfficialPricingAll().catch(() => {});
    ensureProxyInstances().catch(() => {});
    if (state.maintTimer) clearInterval(state.maintTimer);
    state.maintTimer = setInterval(() => {
      refreshProxyUpdateInfo().catch(() => {});
      probeIfDue();
      ensureProxyInstances().catch(() => {});
    }, 5 * 60 * 1000);
    if (state.lifecycleTimer) clearInterval(state.lifecycleTimer);
    state.lifecycleTimer = setInterval(() => { monitorInstanceHealth().catch(() => {}); }, 30 * 1000);
    setTimeout(() => { probeIfDue(); }, 10 * 1000);
    if (state.pricingTimer) clearInterval(state.pricingTimer);
    state.pricingTimer = setInterval(() => refreshOfficialPricingAll().catch(() => {}), 6 * 3600 * 1000);
  }

  function stop() {
    if (state.maintTimer) { clearInterval(state.maintTimer); state.maintTimer = null; }
    if (state.pricingTimer) { clearInterval(state.pricingTimer); state.pricingTimer = null; }
    if (state.lifecycleTimer) { clearInterval(state.lifecycleTimer); state.lifecycleTimer = null; }
  }

  async function monitorInstanceHealth() {
    for (const p of providers()) {
      if (p.supports('instanceLifecycle') && typeof p.monitorLifecycle === 'function') {
        try { await p.monitorLifecycle(); } catch (e) { if (logger && logger.warn) logger.warn('monitorLifecycle: ' + (e && e.message)); }
      }
    }
  }

  async function ensureProviderInstances(p) {
    if (!p || !p.supports('instanceLifecycle')) return;
    if (p.supports('reconcile')) {
      await p.reconcileInstances().catch(() => {});
    }
  }

  async function ensureProxyInstances() {
    if (state.stopped) return;
    for (const p of providers()) {
      if (!p.supports('instanceLifecycle') || p.activated !== true) continue;
      await ensureProviderInstances(p);
    }
  }

  function probeAccountStates() {
    if (state.probeRunning) return Promise.resolve();
    state.probeRunning = true;
    return probeAccountStatesInner().catch((e) => { if (logger && logger.warn) logger.warn('probeAccountStates: ' + e.message); }).finally(() => { state.probeRunning = false; });
  }

  async function probeAccountStatesInner() {
    if (state.stopped) return;
    for (const p of providers()) {
      if (p.supports('instanceLifecycle') && p.activated !== true) continue;
      for (const acc of (p.accounts || [])) {
        if (acc.status === 'registering' || acc.status === 'discarded') continue;
        try {
          let det;
          if (p.supports('instanceLifecycle')) {
            const inst = acc.instance || (p.instances || []).find((i) => i.keyId === acc.keyId);
            if (!inst) continue;
            const isDesired = (typeof p.isDesiredAccount === 'function') ? p.isDesiredAccount(acc) : false;
            const nearReset = acc.nextResetAt && acc.nextResetAt <= now() + 5 * 60 * 1000;
            const missingReset = acc.status === 'frozen' && !acc.nextResetAt;
            const needProbe = acc.status === 'frozen' && (nearReset || missingReset);
            if (!isDesired && !inst.pid && !needProbe) continue;
            const wasRunning = !!inst.pid;
            if (!inst.pid) await p.startInstance(inst).catch(() => {});
            det = await p.detectInstanceQuota(inst).catch((e) => ({ ok: false, error: e.message }));
            if (!wasRunning && !isDesired) p.stopInstance(inst);
          } else {
            det = await p.detectAccount(acc).catch((e) => ({ ok: false, error: e.message }));
          }
          p.applyDetection(acc, det);
        } catch {}
      }
    }
  }

  function reconcileInstances() {
    for (const p of providers()) {
      if (!p.supports('instanceLifecycle') || p.activated !== true) continue;
      try { p.reconcileInstances().catch(() => {}); } catch {}
    }
  }

  function probeIfDue() {
    const t = now();
    for (const p of providers()) {
      for (const a of (p.accounts || [])) {
        if (a.status === 'frozen' && !a.nextResetAt && typeof p._nextResetAt === 'function') {
          const nr = p._nextResetAt(a.quota);
          if (nr.t) a.nextResetAt = nr.t;
        }
      }
    }
    if (!state.lastRefreshAt || t - state.lastRefreshAt >= 10 * 60 * 1000) {
      state.lastRefreshAt = t;
      refreshReadyAccounts().catch(() => {});
    }
    const due = hasImminentReset(providers(), t);
    const overdue = hasOverdueReset(providers(), t);
    if (due || (!state.lastProbeAt || t - state.lastProbeAt >= 3600 * 1000) && overdue) {
      state.lastProbeAt = t;
      probeAccountStates().catch(() => {});
    }
    reconcileInstances();
  }

  function refreshReadyAccounts() {
    if (state.refreshRunning) return Promise.resolve();
    state.refreshRunning = true;
    return refreshReadyAccountsInner().catch(() => {}).finally(() => { state.refreshRunning = false; });
  }

  async function refreshReadyAccountsInner() {
    if (state.stopped) return;
    for (const p of providers()) {
      if (p.supports('instanceLifecycle') && p.activated !== true) continue;
      for (const acc of (p.accounts || [])) {
        if (acc.status !== 'ready') continue;
        try {
          let det;
          if (p.supports('instanceLifecycle')) {
            const inst = acc.instance || (p.instances || []).find((i) => i.keyId === acc.keyId);
            if (!inst) continue;
            if (!inst.pid) continue;
            det = await p.detectInstanceQuota(inst).catch((e) => ({ ok: false, error: e.message }));
          } else {
            det = await p.detectAccount(acc).catch((e) => ({ ok: false, error: e.message }));
          }
          p.applyDetection(acc, det);
        } catch {}
      }
    }
  }

  return {
    start, stop,
    monitorInstanceHealth, ensureProviderInstances, ensureProxyInstances,
    probeAccountStates, reconcileInstances, probeIfDue, refreshReadyAccounts,
  };
}

module.exports = { createScheduler, hasImminentReset, hasOverdueReset };
