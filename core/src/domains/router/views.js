'use strict';

// 状态投影（只读）：把内部状态投影为对外视图。
// 纯聚合——入参显式（state + deps），零 this 跨文件、零 IO（端口 list/探活经 deps 注入）。

/** 服务状态总览（含用量摘要）。 */
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
    running: state.running === true, // 服务运行标志（由 RouterService start/stop 翻转，不在 ctl 方法白名单内）
    activatedProviders: (state.providers || []).filter((x) => x.activated).length, // 已激活供应商数（独立端点在线数）
    providers: provs,
    keysTotal,
    usage: deps.getUsage(),
  };
}

/** 域摘要（router-daemon 黑盒经 ctl 向守卫目录呈报的紧凑摘要，目录只存引用）。
 *  不在摘要内暴露账号明细/令牌/额度。 */
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

/** 资源端口视图（router 自治资源 proxyInstance+providerApi，按 owner 前缀筛；附 TCP active 探测）。 */
async function portsView(state, deps) {
  const recs = deps.ports.list().filter((r) => String(r.owner || '').startsWith('proxy:') || String(r.owner || '').startsWith('providerApi:'));
  const active = await Promise.all(recs.map((r) => deps.probe.portListening('127.0.0.1', r.port, 300)));
  return { records: recs.map((r, i) => ({ port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt, active: !!active[i] })) };
}

/** 供应商列表视图（账号/实例/额度/用量/锁定全量投影）。 */
function listProviders(state, deps) {
  // 配额总览标签单源：与 proxy 检测端同一 quotaOverallStatus
  const byKey = deps.getUsage().byKey || {};
  const quotaOverallStatus = deps.quotaOverallStatus;
  const semverCompare = deps.semverCompare;
  const proxyUpdateCache = state.proxyUpdateCache || {};
  return (state.providers || []).map((p) => {
    // 当前在用/锁定账号（统一派生：显式锁定 selectedAccountKeyId 优先，否则自动在用 activeAccount）
    const activeKeyId = (p.selectedKeyId ? p.selectedKeyId() : (p.selectedAccountKeyId || (p.activeAccount && p.activeAccount.keyId))) || null;
    const accounts = (p.accounts || []).map((a) => {
      const ku = byKey[a.keyId];
      const usageOf = (typeof p.usageOf === 'function') ? p.usageOf(a) : 'idle';
      return {
        keyId: a.keyId,
        maskedKey: a.maskedKey,
        status: a.status,
        usage: usageOf,                          // 纯派生（activeAccount/实例实况）
        quota: a.quota || null,
        limit: (p._previewLimit ? p._previewLimit(a) : a.limit) || null, // limitKind+recovery（只读预览，无写副作用）
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
      // 账号视图附加实例态（一账号一实例：账号行展示实例健康/版本/端口）
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
