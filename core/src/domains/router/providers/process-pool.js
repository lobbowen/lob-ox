'use strict';

const life = require('./instance-lifecycle');
const restart = require('./restart');
const { resetBudget } = restart;
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

    // 启动互斥的作用域 = 单个实例。这把锁要防的是同一实例被重复 spawn（两个调用方各自
    // spawn 出一个孤儿进程），不是跨实例的 npm 下载争用——原来的全局单字段把不同实例、
    // 不同供应商的启动全部串行化，且 30s 后把「排队失败」伪装成「启动失败」返回，
    // 污染 startupFailCount，最终让 reconcile 的自动拉起预算被误耗尽。
    // 同实例的并发已由 inst.startingPromise 去重，因此这里等到锁即可，无需超时。
    async startInstance(inst) {
      if (!this._startLocks) this._startLocks = new Map();
      if (inst.pid) return { ok: true, already: true };
      if (inst.startingPromise) return inst.startingPromise;
      const lockKey = String((inst && inst.keyId) || '') || '@' + String((inst && inst.key) || '');
      inst.startingPromise = (async () => {
        while (this._startLocks.has(lockKey)) { await new Promise((r) => setTimeout(r, 50)); }
        this._startLocks.set(lockKey, true);
        try {
          return await this._doStart(inst);
        } finally {
          this._startLocks.delete(lockKey);
        }
      })();
      try {
        return await inst.startingPromise;
      } finally {
        inst.startingPromise = null;
      }
    }

    // spawnInstance 的契约：返回值恒带 started 事实字段（true=进程已起来）。
    // 任何提前返回/抛错路径都在这里归一，调用方读 started 而不从 ok 反推。
    async _doStart(inst) {
      let r;
      try { r = await probe.spawnInstance(this, inst); }
      catch (e) { return { ok: false, started: false, error: (e && e.message) || String(e) }; }
      const started = !!(r && r.started === true);
      return Object.assign({}, r, { ok: started, started });
    }

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
      try { resetBudget(inst); } catch {}
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
