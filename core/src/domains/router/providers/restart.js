'use strict';

const { INSTANCE_STATES } = require('../model');
const ports = require('../../../platform/service/ports').shared;
const { makeBudget } = require('../../../shared/guardian');

// 统一重启节流（S5 / T4）：代理实例的「启动窗口内失败」复用共享 guardian 预算，
// 与主链、沙箱实例同一条规则、按域参数化。此前代理实例的 reconcile 无限重拉（无上限），
// 是智能路由域游离于统一控制面之外的最直接后果——本补丁把它接回单源节流，
// 达到 burst 即停止自动拉起（phase 落 COLD 且标记 _throttled=true，等窗口过期/人工），
// 不再风暴式重生。
const PROXY_INSTANCE_THROTTLE = { windowMs: 10 * 60 * 1000, burst: 5 };

function budgetFor(inst) {
  if (!inst) return makeBudget(PROXY_INSTANCE_THROTTLE);
  if (!inst._restartBudget) inst._restartBudget = makeBudget(PROXY_INSTANCE_THROTTLE);
  return inst._restartBudget;
}

// 重置预算（人工/窗口过期后的显式重启入口调用）：clear 由 provider.startInstance({manual}) 触发。
function resetBudget(inst) { if (inst) inst._restartBudget = makeBudget(PROXY_INSTANCE_THROTTLE); }

function createRestartOrchestrator(deps) {
  const d = deps || {};
  const { startInstance, waitHealthy, isAlive, logger } = d;
  const isStopping = d.isStopping || (() => false);

  function respawn(inst, ctx) {
    const acc = ctx && ctx.acc;
    const hadPid = ctx && ctx.hadPid;
    if (acc && acc.status === 'ready') {
      setTimeout(() => {
        logger.warn && logger.warn('[proxy-instance] 重启回调触发 key=' + inst.maskedKey + ' accStatus=' + (acc && acc.status) + ' stopping=' + isStopping() + ' pid=' + inst.pid);
        if (isStopping() || acc.status !== 'ready') return;
        if (inst.pid) {
          const alive = isAlive ? isAlive(inst.pid) : true;
          if (alive) return;
          inst.pid = null;
        }
        const attempt = () => startInstance(inst).then((sr) => {
          if (sr && sr.ok) return waitHealthy(inst).then((ok) => { if (!ok) logger.warn && logger.warn('[proxy-instance] 重启后不健康 key=' + inst.maskedKey); });
          logger.warn && logger.warn('[proxy-instance] 重启拉起失败 key=' + inst.maskedKey + ' err=' + (sr && sr.error));
          return null;
        }).catch((e) => { logger.warn && logger.warn('[proxy-instance] 重启拉起异常 key=' + inst.maskedKey + ' ' + (e && e.message)); });
        attempt();
      }, hadPid ? 1200 : 100);
    } else if (logger.debug) {
      logger.debug('[proxy-instance] 重启跳过（账号非 ready）key=' + inst.maskedKey + ' accStatus=' + (acc && acc.status));
    }
  }

  return { respawn };
}

// 受节流门控的 reconcile：每个实例进入「启动窗口内失败」时计入预算，tripped 即停止自动拉起。
async function runReconcileThrottled(provider, allowStop) {
  const out = { started: [], stopped: [], desired: [], throttled: [] };
  const desired = provider.desiredRunningAccounts();
  const list = desired.list || [];
  out.desired = list.map((a) => a.keyId);
  const desiredIds = new Set(out.desired);
  for (const acc of list) {
    const inst = provider.instanceOf(acc);
    if (!inst || inst.pid || inst.startingPromise) continue;
    if (inst.status === INSTANCE_STATES.DEAD && !inst.pid) inst.status = INSTANCE_STATES.COLD;
    const b = budgetFor(inst);
    if (b.tripped) {
      inst._throttled = true;
      out.throttled.push(acc.keyId);
      continue;
    }
    inst._throttled = false;
    const wasRunning = !!inst.pid;
    try {
      const r = await provider.startInstance(inst);
      // 启动窗口内失败（刚拉起即死）= 计入预算；活过窗口后的正常重启不计入（同主链语义）。
      const startupFailure = !r.ok || (!wasRunning && !inst.pid);
      b.note(startupFailure);
      if (r && r.ok) {
        await provider._waitHealthy(inst).catch(() => {});
        out.started.push(acc.keyId);
        if (b.tripped && provider.logger && provider.logger.warn) {
          provider.logger.warn('[reconcile] 实例启动反复失败已达上限 key=' + (acc.maskedKey || acc.keyId) + '，停止自动拉起（等人工/窗口过期）');
        }
        if (provider.logger && provider.logger.info) {
          const role = desired.active && acc.keyId === desired.active.keyId ? '在用' : '预热';
          provider.logger.info('[reconcile] 拉起实例 key=' + acc.maskedKey + '（' + role + '）');
        }
      }
    } catch {}
  }
  // 停止侧：保持既有语义（desired 之外的在跑实例停止/回收）。
  for (const inst of (provider.instances || []).slice()) {
    if (!allowStop) break;
    if (!inst.pid) {
      if (!desiredIds.has(inst.keyId) && inst.port) {
        try { ports.unregister('proxy:' + inst.keyId); } catch {}
        inst.port = null; inst.status = INSTANCE_STATES.COLD; inst.healthy = false;
        provider._persist();
      } else if (inst.status === INSTANCE_STATES.DEAD) {
        inst.status = INSTANCE_STATES.COLD; inst.healthy = false; provider._persist();
      }
      continue;
    }
    const acc = provider.accountOf(inst);
    if (acc && desiredIds.has(acc.keyId)) continue;
    provider.stopInstance(inst);
    out.stopped.push(acc ? acc.keyId : 'orphan:' + inst.keyId);
    if (!acc) {
      provider.instances = (provider.instances || []).filter((i) => i !== inst);
      try { ports.unregister('proxy:' + inst.keyId); } catch {}
      inst.port = null;
      provider._persist();
    }
  }
  return out;
}

async function reconcileInstances(provider, opts) {
  if (!provider.activated || provider._stopping) return { started: [], stopped: [], desired: [] };
  const allowStop = !(opts && opts.stop === false);
  if (provider._reconcileBusy) {
    if (!allowStop) return { started: [], stopped: [], desired: [] };
    try { await provider._reconcileBusy; } catch {}
  }
  if (provider._reconcileBusy) return provider._reconcileBusy;
  const p = runReconcileThrottled(provider, allowStop);
  provider._reconcileBusy = p;
  try { return await p; } finally { if (provider._reconcileBusy === p) provider._reconcileBusy = null; }
}

function reconcileNow(provider) {
  if (provider._stopping) return;
  reconcileInstances(provider).catch(() => {});
}

module.exports = { createRestartOrchestrator, runReconcileThrottled, reconcileInstances, reconcileNow, budgetFor, resetBudget, PROXY_INSTANCE_THROTTLE };
