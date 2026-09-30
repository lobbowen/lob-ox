'use strict';

// process-pool 能力面（mixin）：实例进程治理契约方法在此实现，生命周期引擎（L-A，进程动作唯一发出方）外部只经
// ensureServable / reclaimAccount / _onStatusTransition 门面驱动；调用方以 supports(cap) 守卫不按 kind 分支，ctor 接线在此装配（DG-4：this 图单向）。
// POOL_CAPS：instanceLifecycle=池存在；reconcile=对账；processPool=伞能力（_stopping 纪律/端口恢复守卫）；gracefulStop=在途收敛。

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
      // 删账号钩子：force 回收 + 释放端口 + 剪除实例记录。删除是永久摘除（在途丢弃属预期），
      // 记录不留场，杜绝 reconcile 以 'orphan' 名义补停，也打破 base 到池的 this.stopInstance 反向边。
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

    /** 实例在场是池能力：在基座使用状态（in-use/idle）上覆写派生 warming。 */
    usageOf(acc) {
      const r = super.usageOf(acc);
      if (r !== 'idle') return r;
      const inst = this.instanceOf(acc);
      return inst && inst.pid ? 'warming' : 'idle';
    }

    accountOf(inst) { return this.accounts.find((a) => a.key === inst.key) || null; }

    /** 账号 -> 实例映射（一账号一实例硬规则）。 */
    instanceOf(acc) {
      if (!acc) return null;
      return (this.instances || []).find((i) => i.keyId === acc.keyId) || acc.instance || null;
    }

    /** 启动实例：并发去重（startingPromise）+ 全局串行（_startLock，防 npm 缓存锁风暴）。 */
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

    /** 启动实例底层治理（spawn/探活在 probe.js）。测试以 _doStart 打桩替换 spawn；留在 mixin 侧是为 this 图单向。 */
    async _doStart(inst) { return probe.spawnInstance(this, inst); }

    /** 请求级熔断计数清零；独立于健康监测的 _monitorFails。 */
    markRequestOk(inst) {
      if (!inst) return;
      inst._unhealthyCount = 0;
    }

    /** 统一可服务化门面（LC 核心-1）：幂等启动 + 预算内同步等待，外部不裸调 start/kill。
     *  budgetMs=null 表示等满探活周期（显式切换预算）；超时诚实报错，绝不静默换号。 */
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

    /** 等待区回收唯一入口（LC 核心-3）：force 终止 + 释放端口，账号进程层面同一轮零存在。
     *  冻结零宽限：发不出请求的账号不该继续占进程；丢弃在途属预期语义。幂等。 */
    reclaimAccount(acc) { return life.reclaimAccount(this, acc); }

    /** 状态迁移事件表的进程侧接线（freeze.js setStatus 调用）：进等待区立即回收；
     *  回 ready 立即重算期望集补缺口（LC 核心-5），不等周期对账。 */
    _onStatusTransition(acc, prev, status) {
      if (status === 'frozen' || status === 'banned' || status === 'discarded') {
        try { this.reclaimAccount(acc); } catch {}
      } else if (status === 'ready' && prev && prev !== 'ready') {
        this.reconcileNow();
      }
    }

    /** 实例停止仲裁（在途/在用延后、force 跳过的语义在 instance-lifecycle.js）。 */
    stopInstance(inst, force) { return life.arbitrateStop(this, inst, force); }
    _retryPendingStop(acc) { return life.retryPendingStop(this, acc); }
    async _waitHealthy(inst, tries) { return life.waitHealthy(this, inst, tries); }

    /** 实例重启：在途延后（_restartPending）+ 单实例退避（_restartAt）+ force 停止 + 重拉委托。
     *  退避只在真正执行重启时置位；stop 失败必须可观测（重新记待重启并清退避，不静默黑洞）。 */
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

    /** 请求级熔断：连续 >=2 次报错 -> 重启实例（与健康监测 _monitorFails 独立）。 */
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

    /** 兼容旧名别名。 */
    markInstanceNetFail(instOrAcc) { this.markInstanceProblem(instOrAcc, 'net-error'); }

    /** 实例空闲后补做被延后的重启（_restartPending 的唯一消费点）。 */
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
