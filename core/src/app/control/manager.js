'use strict';

// 生命周期管理器（LifecycleManager）——全部模块生命周期的唯一注册表与统一启停入口。
// 守卫重启只重置本管理器的观测状态，绝不停/杀被管模块（stop 仅在显式请求时执行）；
// 周期拉起由守卫 daemon 监督与实例 watchdog/guardian 承担，本管理器不内置探活。

const { ManagedLifecycle } = require('./entry');

class LifecycleManager {
  constructor(opts) {
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.registrations = new Map(); // id -> ManagedLifecycle
  }

  register(lc) {
    if (!(lc instanceof ManagedLifecycle)) throw new Error('register 需要 ManagedLifecycle 实例');
    this.registrations.set(lc.id, lc);
    if (this.logger && this.logger.debug) this.logger.debug('[lifecycle] 注册 ' + lc.kind + ':' + lc.id);
    return lc;
  }

  unregister(id) {
    const lc = this.registrations.get(id);
    if (lc) { lc._monitoring = false; this.registrations.delete(id); }
  }

  get(id) { return this.registrations.get(id) || null; }

  all() { return [...this.registrations.values()]; }

  /* 统一启停（外部唯一入口） */

  /** 启动模块并纳入监测（desired=running）。 */
  async start(id) {
    const lc = this.registrations.get(id);
    if (!lc) return { ok: false, error: '未注册模块: ' + id };
    // 能力执法：不可启停的模块（如 plugin 聚合）显式拒绝——否则会走 no-op 回调返回 {ok:true} 的假成功
    if (lc.startable === false) return { ok: false, error: '模块不可启停（' + lc.kind + ':' + lc.id + '）' };
    // dsh 由守卫恒监管（internal 状态机）：start 只申报运行意图，不翻转纳管位
    if (id !== 'dsh') lc._monitoring = true;
    lc.wantRunning();
    const r = await lc.start();
    this._emit('lifecycle_started', { id: lc.id, kind: lc.kind, ok: r.ok, error: r.error });
    return { ok: r.ok !== false, error: r.error, already: r.already, ...lc.snapshot() };
  }

  /** 停止模块（从监测移除；守卫 shutdown 时对全部 desired=running 的模块调用）。 */
  async stop(id, reason) {
    const lc = this.registrations.get(id);
    if (!lc) return { ok: false, error: '未注册模块: ' + id };
    if (lc.startable === false) return { ok: false, error: '模块不可启停（' + lc.kind + ':' + lc.id + '）' }; // 同上执法
    // dsh 恒纳管：stop 只改 desired，守卫 internal 状态机继续观测其 desired=stopped 合规
    if (id !== 'dsh') lc._monitoring = false;
    const r = await lc.stop(reason || 'user-stop');
    this._emit('lifecycle_stopped', { id: lc.id, kind: lc.kind, ok: r.ok, reason });
    return { ok: r.ok !== false, error: r.error, already: r.already, ...lc.snapshot() };
  }

  /** 重启（保持 desired 语义）。委托 lc.restart()：_restart 回调优先（如 dsh 经 requestRestart
   *  停旧拉新），无回调才退化为 stop -> start；该回退逻辑由 ManagedLifecycle.restart() 唯一承担
   *  （契约测试锁定），此处不留副本。 */
  async restart(id) {
    const lc = this.registrations.get(id);
    if (!lc) return { ok: false, error: '未注册模块: ' + id };
    if (lc.startable === false) return { ok: false, error: '模块不可启停（' + lc.kind + ':' + lc.id + '）' }; // 同上执法
    const r = await lc.restart();
    return { ok: r.ok !== false, error: r.error, ...lc.snapshot() };
  }

  /** 全部模块状态（统一状态出口，面板只调这一个）。 */
  statusAll() {
    return this.all().map((l) => lc_status(l));
  }

  /** 守卫 shutdown：停全部 monitoring 的模块。契约 RC2：本管理器不内置 dsh 特例——
   *  stopAll 会停掉所有纳管/期望运行项，「守卫退出不动 DSH」由调用方以 exclude:['dsh'] 保证
   *  （见 supervisor.js 的调用）。exclude = 额外豁免的模块 id（如独立 daemon 型 router）。 */
  async stopAll(reason, opts) {
    const exclude = new Set((opts && opts.exclude) || []);
    for (const lc of this.all()) {
      if (exclude.has(lc.id)) continue;
      if (lc._monitoring || lc.desired === 'running') {
        lc._monitoring = false;
        try { await lc.stop(reason || 'guard-shutdown'); } catch {}
      }
    }
  }

  _emit(type, data) {
    if (this.events) { try { this.events.append(type, data); } catch {} }
  }
}

function lc_status(lc) {
  return lc.snapshot();
}

module.exports = { LifecycleManager };
