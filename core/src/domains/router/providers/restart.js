'use strict';

const { INSTANCE_STATES } = require('../model');
const ports = require('../../../platform/service/ports').shared;

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

async function runReconcile(provider, allowStop) {
  const out = { started: [], stopped: [], desired: [] };
  const desired = provider.desiredRunningAccounts();
  const list = desired.list || [];
  out.desired = list.map((a) => a.keyId);
  const desiredIds = new Set(out.desired);
  for (const acc of list) {
    const inst = provider.instanceOf(acc);
    if (!inst || inst.pid || inst.startingPromise) continue;
    if (inst.status === INSTANCE_STATES.DEAD && !inst.pid) inst.status = INSTANCE_STATES.COLD;
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
  const p = runReconcile(provider, allowStop);
  provider._reconcileBusy = p;
  try { return await p; } finally { if (provider._reconcileBusy === p) provider._reconcileBusy = null; }
}

function reconcileNow(provider) {
  if (provider._stopping) return;
  reconcileInstances(provider).catch(() => {});
}

module.exports = { createRestartOrchestrator, runReconcile, reconcileInstances, reconcileNow };
