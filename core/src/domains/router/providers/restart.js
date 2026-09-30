'use strict';

// 重启重拉 + 实例对账编排（IO，provider 经显式入参，零 this 跨文件）。
// 对账 = 生命周期引擎期望集（pool.js）的执行面：拉起缺口 + 回收非期望实例，一律走停止仲裁
// （在途 drain 补刀），无闲置宽限。restartInstance 主体（在途延后/退避/停进程）留在池 mixin——被源码门禁钉住位置。

const { INSTANCE_STATES } = require('../model');
const ports = require('../../../platform/service/ports').shared;

/** 重启重拉编排：kill 后短延迟（等端口释放）-> 拉起 -> 探活。deps 见下方解构清单。 */
function createRestartOrchestrator(deps) {
  const d = deps || {};
  const { startInstance, waitHealthy, isAlive, logger } = d;
  const isStopping = d.isStopping || (() => false);

  /** 重拉一个已被 kill 的实例（账号须为 ready）。ctx = { acc, hadPid }。 */
  function respawn(inst, ctx) {
    const acc = ctx && ctx.acc;
    const hadPid = ctx && ctx.hadPid;
    if (acc && acc.status === 'ready') {
      setTimeout(() => {
        logger.warn && logger.warn('[proxy-instance] 重启回调触发 key=' + inst.maskedKey + ' accStatus=' + (acc && acc.status) + ' stopping=' + isStopping() + ' pid=' + inst.pid);
        if (isStopping() || acc.status !== 'ready') return;
        // 已恢复判定：pid 存在且进程真活（仅看 pid 会误判 adopt 残留）
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

/** 对账单轮（幂等）：拉起期望集缺口 + 回收非期望实例（allowStop 时）+ 收敛残留态。
 *  等待区回收零闲置宽限：在途请求走停止仲裁的 drain 补刀，不是宽限。 */
async function runReconcile(provider, allowStop) {
  const out = { started: [], stopped: [], desired: [] };
  const desired = provider.desiredRunningAccounts();
  const list = desired.list || [];
  out.desired = list.map((a) => a.keyId);
  const desiredIds = new Set(out.desired);
  for (const acc of list) {
    const inst = provider.instanceOf(acc);
    if (!inst || inst.pid || inst.startingPromise) continue; // 已在跑/启动中跳过（幂等）
    if (inst.status === INSTANCE_STATES.DEAD && !inst.pid) inst.status = INSTANCE_STATES.COLD; // 残留态收敛（LC 核心-2）
    try {
      const r = await provider.startInstance(inst);
      if (r && r.ok) {
        await provider._waitHealthy(inst).catch(() => {});
        out.started.push(acc.keyId);
        if (provider.logger && provider.logger.info) {
          const role = desired.active && acc.keyId === desired.active.keyId ? '在用' : '预热';
          provider.logger.info('[reconcile] 拉起实例 key=' + acc.maskedKey + '（' + role + '）');
        }
      }
    } catch {}
  }
  if (!allowStop) return out;
  for (const inst of (provider.instances || []).slice()) {
    if (!inst.pid) {
      // 零进程记录：在用账号可留绑定端口待拉起；非期望集即等待区，端口必须一并归零（LC 核心-3）
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
    provider.stopInstance(inst); // 走仲裁：有在途标记待停（drain 补刀），无在途立即终止
    out.stopped.push(acc ? acc.keyId : 'orphan:' + inst.keyId);
    if (!acc) { // 残余孤儿（旧版本落盘/钩子前崩溃）：端口随之释放，记录不保留
      provider.instances = (provider.instances || []).filter((i) => i !== inst);
      try { ports.unregister('proxy:' + inst.keyId); } catch {}
      inst.port = null;
      provider._persist();
    }
  }
  return out;
}

/** 实例对账（单飞互斥）：周期对账完整跑，事件补起撞 busy 直接跳过。 */
async function reconcileInstances(provider, opts) {
  if (!provider.activated || provider._stopping) return { started: [], stopped: [], desired: [] };
  const allowStop = !(opts && opts.stop === false);
  if (provider._reconcileBusy) {
    if (!allowStop) return { started: [], stopped: [], desired: [] };
    try { await provider._reconcileBusy; } catch {}
  }
  if (provider._reconcileBusy) return provider._reconcileBusy;
  const p = runReconcile(provider, allowStop);
  provider._reconcileBusy = p;
  try { return await p; } finally { if (provider._reconcileBusy === p) provider._reconcileBusy = null; }
}

/** 事件驱动即时对账（冻结/切换/恢复后）：期望集收敛（拉起缺口 + 非期望回收，在途走仲裁补刀）。 */
function reconcileNow(provider) {
  if (provider._stopping) return;
  reconcileInstances(provider).catch(() => {});
}

module.exports = { createRestartOrchestrator, runReconcile, reconcileInstances, reconcileNow };
