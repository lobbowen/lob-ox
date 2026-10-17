'use strict';

const { INSTANCE_STATES } = require('../model');
const ports = require('../../../platform/service/ports').shared;
const { makeBudget } = require('../../../shared/guardian');

const PROXY_INSTANCE_THROTTLE = { windowMs: 10 * 60 * 1000, burst: 5 };

function budgetFor(inst) {
  if (!inst) return makeBudget(PROXY_INSTANCE_THROTTLE);
  if (!inst._restartBudget) inst._restartBudget = makeBudget(PROXY_INSTANCE_THROTTLE);
  return inst._restartBudget;
}

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
          if (sr && sr.started) return waitHealthy(inst).then((ok) => { if (!ok) logger.warn && logger.warn('[proxy-instance] 重启后不健康 key=' + inst.maskedKey); });
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
      
      // started 是与 ok 并列的事实字段：spawnInstance 的终态自带它，
      // 调用方读它而不是从 ok 反推（stoppedDuringShutdown 时 ok 为真但实例已被收走）。
      const started = !!(r && r.started === true);
      // ⚠️ 全仓共四处 startupFailure 判据（同名不同源，别对齐）：
      //   ① instance/state-machine.js        相位判 + THROTTLE_DEFAULTS 10min/5 次 → 沙箱重启策略
      //   ② instance/lifecycle.js            startAt 时间差 + STARTUP_WINDOW_MS 30s → 壳 last_will 上报
      //   ③ app/main/process.js             相位判 + config.startupFailWindowMs(60s) → 主 DSH 重启策略
      //   ④ router/providers/restart.js（本处） started/wasRunning 判 + b.note() 限流器 → 反代实例
      // 本处（④）判据形状与另三处都不同（布尔组合、无时间窗口）：判的是**反代实例
      // 这一次拉起有没有成功**（`!started` = 根本没起来；`!wasRunning && !inst.pid`
      // = 拉起后进程没留住），窗口在 b.note() 内部的限流器（PROXY_INSTANCE_THROTTLE）。
      // 但 b.note() → makeBudget.note() → guardian.bumpStartupFailure，故本处与 ①③
      // **共享同一节流原语**，只是参数来源不同。
      const startupFailure = !started || (!wasRunning && !inst.pid);
      b.note(startupFailure);
      if (started) {
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
