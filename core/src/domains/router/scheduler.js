'use strict';

// 周期维护调度 + 账号探测执行：拥有全部周期/延时定时器；定时器回调经 deps 注入（本模块只触发
// 不实现），探测执行读 state.providers（活数组）并对运行期 provider 对象调其方法。

/** 是否存在 frozen 账号临近解冻（nextResetAt 不晚于 now+5min）需提前精确触发检测；
 *  frozen 且无 nextResetAt 也视为 imminent（立即确认真实额度，避免永久错冻）。 */
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

/** 是否存在 nextResetAt 已过但未恢复的 frozen 账号（1h 低频兜底触发）；
 *  frozen 但恢复点缺失同样计入（需立即确认真实额度）。 */
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

  /* ---- 周期维护：反代更新检测 / 账号状态轮询 / 实例对账 ---- */
  function start() {
    // 启动即拉一次：反代版本检查（内部自带 6h TTL）+ 官方配额 + 官方单价
    refreshProxyUpdateInfo().catch(() => {});
    refreshOfficialUsageAll().catch(() => {});
    refreshOfficialPricingAll().catch(() => {});
    // 进程态不落盘，重启后由 reconcile 按期望集拉起（每供应商常驻 1，必要时 1 备胎）
    ensureProxyInstances().catch(() => {});
    if (state.maintTimer) clearInterval(state.maintTimer);
    state.maintTimer = setInterval(() => {
      refreshProxyUpdateInfo().catch(() => {});
      probeIfDue(); // 账号状态轮询（1h + 临近精确触发）+ 闲置实例回收
      ensureProxyInstances().catch(() => {});
    }, 5 * 60 * 1000);
    // 实例生命周期监控（30s：进程存活/端口归属检查 + HTTP 卡死探活，见 probe.js#monitorLifecycle）
    if (state.lifecycleTimer) clearInterval(state.lifecycleTimer);
    state.lifecycleTimer = setInterval(() => { monitorInstanceHealth().catch(() => {}); }, 30 * 1000);
    // 启动 10s 后再做账号状态轮询（避开启动瞬间与实例保障并发拉进程）
    setTimeout(() => { probeIfDue(); }, 10 * 1000);
    if (state.pricingTimer) clearInterval(state.pricingTimer);
    state.pricingTimer = setInterval(() => refreshOfficialPricingAll().catch(() => {}), 6 * 3600 * 1000);
  }

  function stop() {
    if (state.maintTimer) { clearInterval(state.maintTimer); state.maintTimer = null; }
    if (state.pricingTimer) { clearInterval(state.pricingTimer); state.pricingTimer = null; }
    if (state.lifecycleTimer) { clearInterval(state.lifecycleTimer); state.lifecycleTimer = null; }
  }

  /** 周期驱动 provider 生命周期监控（adopt 实例无 exit 事件，须轮询发现进程/卡死异常）。 */
  async function monitorInstanceHealth() {
    for (const p of providers()) {
      if (p.supports('instanceLifecycle') && typeof p.monitorLifecycle === 'function') {
        try { await p.monitorLifecycle(); } catch (e) { if (logger && logger.warn) logger.warn('monitorLifecycle: ' + (e && e.message)); }
      }
    }
  }

  /** 单个供应商实例对账（幂等 reconcile）：期望集判据唯一在 providers/pool.js。 */
  async function ensureProviderInstances(p) {
    if (!p || !p.supports('instanceLifecycle')) return;
    if (p.supports('reconcile')) {
      await p.reconcileInstances().catch(() => {});
    }
  }

  /** 反代实例对账（周期/启动/激活）：只对「已激活」供应商执行（未激活不提供服务）。 */
  async function ensureProxyInstances() {
    if (state.stopped) return; // 服务停止闸门：禁止异步对账复活实例
    for (const p of providers()) {
      if (!p.supports('instanceLifecycle') || p.activated !== true) continue;
      await ensureProviderInstances(p);
    }
  }

  /** 账号状态轮询（状态机核心）：每小时全量 + nextResetAt 临近精确触发。 */
  function probeAccountStates() {
    // in-flight 去重：单轮探测可能超过 5min 周期与下一轮重叠（并发探测同一账号，违背自身防风控目标）
    if (state.probeRunning) return Promise.resolve();
    state.probeRunning = true;
    return probeAccountStatesInner().catch((e) => { if (logger && logger.warn) logger.warn('probeAccountStates: ' + e.message); }).finally(() => { state.probeRunning = false; });
  }

  async function probeAccountStatesInner() {
    if (state.stopped) return; // 服务停止闸门
    for (const p of providers()) {
      if (p.supports('instanceLifecycle') && p.activated !== true) continue; // 未激活供应商不探测/不临时起实例
      for (const acc of (p.accounts || [])) {
        if (acc.status === 'registering' || acc.status === 'discarded') continue;
        try {
          let det;
          if (p.supports('instanceLifecycle')) {
            const inst = acc.instance || (p.instances || []).find((i) => i.keyId === acc.keyId);
            if (!inst) continue;
            // 是否期望运行账号（常驻/备胎，由 reconcile 期望集同源判定）
            const isDesired = (typeof p.isDesiredAccount === 'function') ? p.isDesiredAccount(acc) : false;
            // 探测最小化（倒计时机制，防风控）：非活跃账号不临时激活。
            // missingReset：frozen 且无 nextResetAt，也需立即探测（确认真实额度）。
            const nearReset = acc.nextResetAt && acc.nextResetAt <= now() + 5 * 60 * 1000;
            const missingReset = acc.status === 'frozen' && !acc.nextResetAt;
            const needProbe = acc.status === 'frozen' && (nearReset || missingReset);
            if (!isDesired && !inst.pid && !needProbe) continue;
            const wasRunning = !!inst.pid;
            if (!inst.pid) await p.startInstance(inst).catch(() => {});
            det = await p.detectInstanceQuota(inst).catch((e) => ({ ok: false, error: e.message }));
            // 检测完停用：仅期望运行账号保持运行（临时激活的检测实例即停）
            if (!wasRunning && !isDesired) p.stopInstance(inst);
          } else {
            det = await p.detectAccount(acc).catch((e) => ({ ok: false, error: e.message }));
          }
          p.applyDetection(acc, det);
        } catch {}
      }
    }
  }

  /** 实例对账转发（启停唯一决策入口）：委托各 provider.reconcileInstances（幂等）。 */
  function reconcileInstances() {
    for (const p of providers()) {
      if (!p.supports('instanceLifecycle') || p.activated !== true) continue;
      try { p.reconcileInstances().catch(() => {}); } catch {}
    }
  }

  /** 维护周期入口（每 5min 触发）。
   *  - 精确触发：任一 frozen 账号 nextResetAt 不晚于 now+5min 时探测该批账号；
   *  - 低频兜底：1h 一次，仅探测 nextResetAt 已过但未恢复的账号。 */
  function probeIfDue() {
    const t = now();
    // 本地倒计时计算（不探测 API）：frozen 账号从 quota.resetsAt 推算 nextResetAt（缺失时兜底补齐）
    for (const p of providers()) {
      for (const a of (p.accounts || [])) {
        if (a.status === 'frozen' && !a.nextResetAt && typeof p._nextResetAt === 'function') {
          const nr = p._nextResetAt(a.quota);
          if (nr.t) a.nextResetAt = nr.t;
        }
      }
    }
    // 使用中账号每 10 分钟刷新（信息化管理）：ready 账号定期检测额度。
    if (!state.lastRefreshAt || t - state.lastRefreshAt >= 10 * 60 * 1000) {
      state.lastRefreshAt = t;
      refreshReadyAccounts().catch(() => {});
    }
    const due = hasImminentReset(providers(), t);   // 到点/临近精确触发
    const overdue = hasOverdueReset(providers(), t); // 1h 兜底：已过未恢复
    if (due || (!state.lastProbeAt || t - state.lastProbeAt >= 3600 * 1000) && overdue) {
      state.lastProbeAt = t;
      probeAccountStates().catch(() => {});
    }
    reconcileInstances();
  }

  /** 刷新 ready（使用中）账号额度：只探测已在运行实例，经 applyDetection 驱动冻结/恢复状态机。 */
  function refreshReadyAccounts() {
    if (state.refreshRunning) return Promise.resolve();
    state.refreshRunning = true;
    return refreshReadyAccountsInner().catch(() => {}).finally(() => { state.refreshRunning = false; });
  }

  async function refreshReadyAccountsInner() {
    if (state.stopped) return; // 服务停止闸门
    for (const p of providers()) {
      if (p.supports('instanceLifecycle') && p.activated !== true) continue; // 未激活供应商不轮询/不预热实例
      for (const acc of (p.accounts || [])) {
        if (acc.status !== 'ready') continue;
        try {
          let det;
          if (p.supports('instanceLifecycle')) {
            const inst = acc.instance || (p.instances || []).find((i) => i.keyId === acc.keyId);
            if (!inst) continue;
            // 10min 刷新只探测「已在运行」的账号（不临时拉起全部 ready 账号做额度检测）
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
