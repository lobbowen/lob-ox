'use strict';

const life = require('./instance-lifecycle');
const restart = require('./restart');
const probe = require('./probe');
const pool = require('./pool');
const pidlook = require('../../../platform/os/pidlookup');
const ports = require('../../../platform/service/ports').shared;
const { isServable } = require('../model');

const POOL_CAPS = ['instanceLifecycle', 'reconcile', 'processPool', 'gracefulStop'];

function withProcessPool(Base) {
  return class ProcessPoolMixin extends Base {
    constructor(o) {
      super(o);
      this._restart = restart.createRestartOrchestrator({
        startInstance: (inst) => this.startInstance(inst),
        waitHealthy: (inst) => this._waitHealthy(inst),
        isAlive: (pid) => { try { return pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { return true; } },
        logger: this.logger,
        isStopping: () => this._stopping,
      });
      this._hooks = this._hooks || {};
      this._hooks.onDiscardAccount = (acc) => {
        if (acc.instance) { try { this.stopInstance(acc.instance, true); } catch {} }
        try { ports.unregister('proxy:' + acc.keyId); } catch {}
        if (acc.instance) {
          acc.instance.port = null;
          this.instances = (this.instances || []).filter((i) => i !== acc.instance);
        }
      };
    }

    supports(cap) {
      return POOL_CAPS.includes(cap) || super.supports(cap);
    }

    usageOf(acc) {
      const r = super.usageOf(acc);
      if (r !== 'idle') return r;
      const inst = this.instanceOf(acc);
      return inst && inst.pid ? 'warming' : 'idle';
    }

    accountOf(inst) { return this.accounts.find((a) => a.key === inst.key) || null; }

    instanceOf(acc) {
      if (!acc) return null;
      return (this.instances || []).find((i) => i.keyId === acc.keyId) || acc.instance || null;
    }

    async startInstance(inst) {
      if (inst.pid) return { ok: true, already: true };
      if (inst.startingPromise) return inst.startingPromise;
      inst.startingPromise = (async () => {
        try {
          const lockWaitStart = Date.now();
          while (this._startLock && Date.now() - lockWaitStart < 30000) { await new Promise((r) => setTimeout(r, 250)); }
          if (this._startLock) return { ok: false, error: '实例启动互斥锁超时（前一次启动未完成）' };
          this._startLock = true;
          try {
            return await this._doStart(inst);
          } finally {
            this._startLock = false;
          }
        } finally {
          inst.startingPromise = null;
        }
      })();
      return inst.startingPromise;
    }

    async _doStart(inst) { return probe.spawnInstance(this, inst); }

    markRequestOk(inst) {
      if (!inst) return;
      inst._unhealthyCount = 0;
    }

    async ensureServable(acc, opts) {
      const inst = this.instanceOf(acc);
      if (!inst) return { ok: false, error: '实例不存在' };
      if (isServable(inst)) return { ok: true };
      const sr = await this.startInstance(inst).catch((e) => ({ ok: false, error: e && e.message }));
      if (!sr || !sr.ok) return { ok: false, error: (sr && sr.error) || '启动失败' };
      const budgetMs = opts && opts.budgetMs === null ? null : ((opts && opts.budgetMs) || pool.SWITCH_BUDGET_MS);
      const healthyP = this._waitHealthy(inst).catch(() => false);
      const healthy = budgetMs === null
        ? await healthyP
        : await Promise.race([healthyP, new Promise((r) => setTimeout(() => r(false), budgetMs))]);
      if (healthy && isServable(inst)) return { ok: true };
      return { ok: false, warming: !!inst.pid, error: '实例未在等待期内就绪' };
    }

    reclaimAccount(acc) { return life.reclaimAccount(this, acc); }

    _onStatusTransition(acc, prev, status) {
      if (status === 'frozen' || status === 'banned' || status === 'discarded') {
        try { this.reclaimAccount(acc); } catch {}
      } else if (status === 'ready' && prev && prev !== 'ready') {
        this.reconcileNow();
      }
    }

    stopInstance(inst, force) { return life.arbitrateStop(this, inst, force); }
    _retryPendingStop(acc) { return life.retryPendingStop(this, acc); }
    async _waitHealthy(inst, tries) { return life.waitHealthy(this, inst, tries); }

    restartInstance(inst, reason) {
      if (!inst || this._stopping) return;
      if (!inst.pid && !inst.port) return;
      if (Date.now() < (inst._restartAt || 0)) return;
      const acc = this.accountOf(inst);
      if (acc && (acc.inflight || 0) > 0) {
        inst._restartPending = reason || 'deferred';
        if (this.logger && this.logger.info) this.logger.info('[proxy-instance] 在途请求中，重启延后 key=' + inst.maskedKey + ' reason=' + inst._restartPending);
        return;
      }
      inst._restartAt = Date.now() + 120000;
      inst._restartPending = null;
      if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 实例重启 key=' + inst.maskedKey + ' port=' + inst.port + ' reason=' + reason);
      const hadPid = !!inst.pid;
      try { this.stopInstance(inst, true); } catch (e) { this.logger.warn && this.logger.warn('[proxy-instance] 重启 stop 异常: ' + (e && e.message)); }
      if (inst.pid) {
        let stillAlive = true;
        try { stillAlive = (typeof pidlook !== 'undefined' && pidlook.isAlive) ? pidlook.isAlive(inst.pid) : true; } catch {}
        if (stillAlive) {
          inst._restartAt = 0;
          inst._restartPending = reason || 'restart-stop-failed';
          if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 重启未能停止进程 pid=' + inst.pid + ' key=' + inst.maskedKey + '，已重新记待重启（不静默）');
          return;
        }
      }
      this._restart.respawn(inst, { acc, hadPid });
    }

    markInstanceProblem(instOrAcc, reason) {
      try {
        const inst = instOrAcc && instOrAcc.pid ? instOrAcc : null;
        if (!inst) return;
        inst._unhealthyCount = (inst._unhealthyCount || 0) + 1;
        inst.healthy = false;
        inst._lastProblem = reason || 'unknown';
        const failN = inst._unhealthyCount;
        if (failN >= 2) {
          inst._unhealthyCount = 0;
          this.restartInstance(inst, 'req-' + (reason || 'unknown') + ' x' + failN);
        }
      } catch {}
    }

    markInstanceNetFail(instOrAcc) { this.markInstanceProblem(instOrAcc, 'net-error'); }

    flushRestartPending(inst) {
      if (!inst || !inst._restartPending) return;
      const acc = this.accountOf(inst);
      if (acc && (acc.inflight || 0) > 0) return;
      const why = inst._restartPending;
      inst._restartPending = null;
      if (this.logger && this.logger.info) {
        this.logger.info('[proxy-instance] 实例已空闲，补做延后的重启 key=' + inst.maskedKey + ' reason=' + why);
      }
      try { this.restartInstance(inst, why); } catch (e) {
        this.logger.warn && this.logger.warn('[proxy-instance] 补做重启异常: ' + (e && e.message));
      }
    }

    reconcileInstances(opts) { return restart.reconcileInstances(this, opts); }
  };
}

module.exports = { withProcessPool, POOL_CAPS };
