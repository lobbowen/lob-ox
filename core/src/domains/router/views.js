'use strict';

function status(state, deps) {
  let keysTotal = 0;
  const provs = (state.providers || []).map((p) => {
    const accounts = (p.accounts || []);
    keysTotal += accounts.length;
    return {
      id: p.id, name: p.name, kind: p.kind, proxyAppId: p.proxyAppId || null,
      accounts: accounts.map((a) => ({ maskedKey: a.maskedKey, keyId: a.keyId, status: a.status, quota: a.quota || null, nextResetAt: a.nextResetAt || null })),
      proxyRunning: p.proxyRunning || false,
    };
  });
  return {
    running: state.running === true,
    activatedProviders: (state.providers || []).filter((x) => x.activated).length,
    providers: provs,
    keysTotal,
    usage: deps.getUsage(),
  };
}

function domainSummary(state, deps) {
  let providers = 0;
  let activatedProviders = 0;
  let accounts = 0;
  let proxyInstances = 0;
  for (const p of state.providers || []) {
    providers += 1;
    if (p.activated === true) activatedProviders += 1;
    accounts += (p.accounts || []).length;
    proxyInstances += (p.instances || []).length;
  }
  let resourcePorts = 0;
  try {
    resourcePorts = (deps.ports.list() || []).filter((r) => String(r.owner || '').startsWith('proxy:') || String(r.owner || '').startsWith('providerApi:')).length;
  } catch {}
  return {
    runState: state.running === true ? 'running' : 'stopped',
    providers, activatedProviders, accounts, proxyInstances, resourcePorts,
  };
}

async function portsView(state, deps) {
  const recs = deps.ports.list().filter((r) => String(r.owner || '').startsWith('proxy:') || String(r.owner || '').startsWith('providerApi:'));
  const active = await Promise.all(recs.map((r) => deps.probe.portListening('127.0.0.1', r.port, 300)));
  return { records: recs.map((r, i) => ({ port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt, active: !!active[i] })) };
}

function listProviders(state, deps) {
  const byKey = deps.getUsage().byKey || {};
  const quotaOverallStatus = deps.quotaOverallStatus;
  const semverCompare = deps.semverCompare;
  const proxyUpdateCache = state.proxyUpdateCache || {};
  return (state.providers || []).map((p) => {
    const activeKeyId = (p.selectedKeyId ? p.selectedKeyId() : (p.selectedAccountKeyId || (p.activeAccount && p.activeAccount.keyId))) || null;
    const accounts = (p.accounts || []).map((a) => {
      const ku = byKey[a.keyId];
      const usageOf = (typeof p.usageOf === 'function') ? p.usageOf(a) : 'idle';
      return {
        keyId: a.keyId,
        maskedKey: a.maskedKey,
        status: a.status,
        usage: usageOf,
        quota: a.quota || null,
        limit: (p._previewLimit ? p._previewLimit(a) : a.limit) || null,
        nextResetAt: a.nextResetAt || null,
        registeredAt: a.registeredAt,
        detectError: a.detectError || null,
        selected: activeKeyId === a.keyId,
        locked: !!p.selectedAccountKeyId && p.selectedAccountKeyId === a.keyId,
        inUse: usageOf === 'in-use' || (p.activeAccount && p.activeAccount.keyId === a.keyId),
        requests: (ku && ku.requests) || 0,
        totalTokens: (ku && ku.totalTokens) || 0,
        usable: p.isAccountUsable ? p.isAccountUsable(a) : false,
        quotaStatus: quotaOverallStatus(a && a.quota),
      };
    });
    const view = {
      id: p.id,
      name: p.name,
      kind: p.kind,
      activated: p.activated === true,
      apiPort: p.apiPort || null,
      apiBase: (p.activated && p.apiPort) ? ('http://127.0.0.1:' + p.apiPort + '/v1') : null,
      accounts,
      exhausted: accounts.length > 0 && !accounts.some((a) => a.usable),
    };
    if (p.kind === 'proxy') {
      view.proxyAppId = p.proxyAppId || null;
      view.proxyRunning = p.proxyRunning || false;
      view.selectedAccountKeyId = p.selectedAccountKeyId;
      view.locked = !!p.selectedAccountKeyId;
      const instByKey = {};
      for (const i of p.instances || []) instByKey[i.keyId] = i;
      const appVer = (proxyUpdateCache[p.proxyAppId] && proxyUpdateCache[p.proxyAppId].latest) || null;
      for (const a of view.accounts) {
        const inst = instByKey[a.keyId];
        if (inst) {
          a.instanceStatus = inst.status;
          a.healthy = !!inst.healthy;
          a.version = inst.version || null;
          a.updateAvailable = !!(appVer && inst.version && semverCompare(appVer, inst.version) > 0);
        }
      }
      view.instances = (p.instances || []).map((i) => ({
        keyId: i.keyId,
        maskedKey: i.maskedKey,
        status: i.status,
        healthy: i.healthy,
        quota: i.quota || null,
        version: i.version || null,
        selected: activeKeyId === i.keyId,
      }));
    } else {
      view.baseUrl = p.baseUrl || '';
      view.plan = p.plan || null;
      view.pricing = p.pricing || {};
      view.activeAccountKeyId = p.activeAccount ? p.activeAccount.keyId : null;
      view.activeAccountMasked = p.activeAccount ? p.activeAccount.maskedKey : null;
      view.locked = !!p.selectedAccountKeyId;
    }
    view.activeKeyId = activeKeyId;
    return view;
  });
}

module.exports = { status, listProviders, domainSummary, portsView };
