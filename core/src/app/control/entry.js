'use strict';

// 统一生命周期抽象（ManagedLifecycle）：启停只走统一入口（start/stop/restart），守卫经 LifecycleManager 观测/按策略拉起。
// 写权分工与违规基线见契约 GUARD-DOMAIN-MODEL（ML-2 ratchet 机器执法）。
// 进程独立性：本对象是「管理视图」，模块进程可独立于守卫存在——守卫重启只重置观测，不停/杀模块；周期拉起在守卫侧，本对象不内置探活。

// phase 词表唯一源在 registry.js，必须直接引用：_setPhase 对表外的值静默丢弃，
// 手写副本会随 canonical 漂移并把合法值无声拒绝，形成第二个状态源。
const { PHASES } = require('./registry');

/** 统一生命周期状态对象（每个模块实例一个，注册到 LifecycleManager）。
 *  opts: id/kind/name + 回调 start/stop/restart/status（由 LifecycleManager 驱动调用）。 */
class ManagedLifecycle {
  constructor(opts) {
    this.id = opts.id || ('lc-' + Math.random().toString(36).slice(2, 8));
    this.kind = opts.kind || 'module';
    this.name = opts.name || this.id;
    // 能力声明（MANAGED_KINDS.startable/guardable 的消费点）：
    //   startable=false：LifecycleManager.start/stop/restart 显式拒绝，不「返回 ok 但什么都不做」；
    //   guardable=false：构造期锁定 guardian=false，防被误开为守护。
    this.startable = opts.startable !== false;
    this.guardable = opts.guardable !== false;
    this.logger = opts.logger || null;
    this.events = opts.events || null;
    this._start = opts.start || null;
    this._stop = opts.stop || null;
    this._restart = opts.restart || null;
    this._status = opts.status || null;
    this.phase = 'stopped';       // 守卫视角观测到的阶段
    this.desired = 'stopped';     // 用户意图（running=应保持运行）
    this.healthy = false;         // 最近一次观测结果
    this.lastProbeAt = null;      // 本对象不内置探活、不自行更新；由守卫视图同步写入
    this.lastTransitionAt = null;
    this.error = null;            // 最近一次错误
    this.startedAt = null;
    // 不设模块级重启计数字段：真正的计数在域 A 侧——dsh 走 app/main/process.js 的
    // restartCount（supervisor._mSetRestartCount），沙箱走实例自身 state.restartCount。
    // 守护开关（域 A 专有，契约 GUARD-DOMAIN-MODEL G-1）：true=崩溃时按用户意图自愈；
    // 域 B 基础设施由保活路径无条件拉起，adapters 不为其置 guardian；guardable=false 恒为 false。
    this.guardian = this.guardable && opts.guardian === true;
    this._monitoring = false;     // 是否纳入统一启停管理
  }

  /* 状态查询（统一，供 LifecycleManager / API / 面板） */
  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      phase: this.phase,
      desired: this.desired,
      healthy: this.healthy,
      startedAt: this.startedAt,
      lastProbeAt: this.lastProbeAt,
      lastTransitionAt: this.lastTransitionAt,
      error: this.error,
      guardian: this.guardian === true,
      startable: this.startable, // UI 据此灰化启停入口
      guardable: this.guardable,
      monitoring: this._monitoring,
      detail: this._status ? (this._status() || null) : null,
    };
  }

  /** 状态迁移。非白名单值静默丢弃是执法不是 bug：phase 只取 canonical 词表，
   *  防止手写字符串造成分叉；代价是写错不报错，故词表必须引用唯一源。 */
  _setPhase(p) {
    if (!PHASES.includes(p)) return;
    if (this.phase !== p) {
      this.phase = p;
      this.lastTransitionAt = new Date().toISOString();
    }
  }

  /* 供 LifecycleManager 调用的统一操作 */

  wantRunning() {
    this.desired = 'running';
    this.error = null;
  }

  wantStopped() {
    this.desired = 'stopped';
  }

  /** 启动（幂等：已在运行则 no-op）。必须尊重回调的显式失败：适配器 start 可能返回
   *  {ok:false}（如 daemon 拉不起来），不看 r.ok 就置 running/healthy 会让
   *  /lifecycle/status 谎报成功。r.ok !== false 视为成功（允许回调返回 undefined）。 */
  async start() {
    if (this.phase === 'running' || this.phase === 'starting') return { ok: true, already: true };
    this.error = null;
    this._setPhase('starting');
    try {
      const r = this._start ? await this._start() : { ok: true };
      if (r && r.ok === false) {
        // 回调显式报告失败：不得置 running/healthy
        this.error = r.error || 'start 返回 ok:false（未提供 error）';
        this._setPhase('stopped');
        this.healthy = false;
        this.desired = 'stopped';
        if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' start 被拒: ' + this.error);
        return { ok: false, error: this.error, ...this.snapshot() };
      }
      this.startedAt = this.startedAt || new Date().toISOString();
      this.desired = 'running';
      this._setPhase('running');
      this.healthy = true;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase('stopped');
      // 抛异常与显式失败同语义（K4-e），desired 也必须一并复位：留着 running 就是把
      //   「回调没跑完、意图根本没落库」的半程状态当成用户意图，会被面板与收敛回路当真。
      this.desired = 'stopped';
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' start 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  /** 停止（守卫 shutdown 或用户显式停）。同样必须尊重回调显式失败：ok:false 时
   *  不得置 stopped，否则面板显示「已停止」而进程可能还在跑。 */
  async stop(reason) {
    if (this.phase === 'stopped') {
      // 早退也要落 desired：否则 desired=running / phase=stopped 的模块被点停止后
      // desired 仍为 running，收敛回路会把它重新拉起，stop 不生效。
      // 只改这条早退路径；显式失败路径（下方 prevPhase 恢复）必须保持 desired 不变。
      this.desired = 'stopped';
      return { ok: true, already: true };
    }
    // 失败时恢复进入前的 phase 而非硬编码 'running'：若之前是 failed/backoff 等
    // 已知失败态，硬编码会把模块谎报成运行中，与观测相反。
    const prevPhase = this.phase;
    this._setPhase('draining');
    try {
      const r = this._stop ? await this._stop(reason) : { ok: true };
      if (r && r.ok === false) {
        this.error = r.error || 'stop 返回 ok:false（未提供 error）';
        this._setPhase(prevPhase); // 未能确认停止 -> 恢复原相位，不谎报
        if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' stop 被拒: ' + this.error);
        return { ok: false, error: this.error, ...this.snapshot() };
      }
      this.desired = 'stopped';
      this._setPhase('stopped');
      this.healthy = false;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase(prevPhase); // 同上：恢复原相位
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' stop 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  /** 重启（无 _restart 回调时退化为 stop -> start）。两步返回值都不得丢弃显式失败：
   *  stop 失败=模块仍在跑、重启未发生；start 失败=已停但未起。 */
  async restart() {
    if (this._restart) {
      const r = await this._restart();
      // snapshot 含 error 字段，展开必须在前，否则回调的 error 被覆盖。
      if (r && r.ok === false) return { ...this.snapshot(), ok: false, error: r.error };
      return { ...this.snapshot(), ok: r && r.ok !== false };
    }
    const wasDesired = this.desired;
    const rs = await this.stop('restart');
    if (rs && rs.ok === false) {
      return { ...this.snapshot(), ok: false, error: 'restart: 停止失败 — ' + (rs.error || '未知') };
    }
    if (wasDesired === 'running') {
      const rt = await this.start();
      if (rt && rt.ok === false) {
        return { ...this.snapshot(), ok: false, error: 'restart: 启动失败 — ' + (rt.error || '未知') };
      }
    }
    return { ...this.snapshot(), ok: true };
  }
}

module.exports = { ManagedLifecycle, PHASES };
