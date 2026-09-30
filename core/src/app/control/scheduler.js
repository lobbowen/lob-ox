'use strict';

// app/control/scheduler.js —— 周期调度（tick 为 _dshConverge 别名）。装配：compose.js 以
// Object.assign(host, mod.methods) 注入（DS-G3）；宿主绑定经按 host 缓存的惰性 deps，方法内不用 this。
const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      main: () => host.main, session: () => host.session, control: () => host.control,
      logger: () => host.logger, audit: () => host.audit, eventHub: () => host.eventHub,
      state: () => host.state,
      stopping: () => host._stopping,
      exitIntended: () => host._exitIntended(),
      readLastOrphanAuditAt: () => host._lastOrphanAuditAt,
      writeLastOrphanAuditAt: (v) => { host._lastOrphanAuditAt = v; },
      mLastProbeOk: () => host._mLastProbeOk(),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  /** tick 保留为 _dshConverge 别名：外部收敛触发点（start 首拍 / setDesired / requestRestart /
   *  _exitUpgradeHold）调用；shadow 模式的定时器也驱动此别名。on 模式下 main 每拍收敛由
   *  heartbeat 的 dsh supervise 直接调 _dshConverge（无独立 tick 定时器）。 */
  async tick() {
    const d = depsOf(this);
    return d.main().converge();
  },

  async _dshSuperviseOnce() {
    const d = depsOf(this);
    try {
      if (d.stopping()) return { ok: false, error: 'guard stopping' };
      if (d.exitIntended()) return { ok: false, error: 'exit intended' }; // INV-S1/E-3：意图轴单源（stopping 或 session halting；_shellHalted 属壳域不在此）
      await d.main().converge(); // 唯一心跳驱动 main 收敛
      try { d.control().syncInstancesView(); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('instances view sync: ' + ((e && e.message) || e)); } // 聚合视图随心跳刷新
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('[dsh] supervise 异常: ' + ((e && e.message) || e));
    }
    d.main().shadowHeartbeat(); // 影子聚合：每拍对新 tick 记录记账/事件
    // 游离对象自检（低频 ~60s，只告警）：目录/期望之外的受管族进程与端口
    try {
      const now = Date.now();
      if (!d.readLastOrphanAuditAt() || now - d.readLastOrphanAuditAt() > 60000) {
        d.writeLastOrphanAuditAt(now);
        d.audit().orphan();
      }
    } catch (e) { d.logger() && d.logger().debug && d.logger().debug('orphan audit: ' + ((e && e.message) || e)); }
    // 守卫 EventHub 每拍聚合 guard + daemon（ctl 拉尾，节流 ~6 拍）事件
    if (d.eventHub()) { try { await d.eventHub().sync(); } catch (e) { d.logger() && d.logger().debug && d.logger().debug('eventHub sync: ' + ((e && e.message) || e)); } }
    // 观测语义：ok 与 tick 探测同源（lastProbeOk = L1 端口在线）
    return {
      ok: d.mLastProbeOk() === true,
      error: d.mLastProbeOk() ? null : (d.state().phase() === 'STOPPED' ? '未运行' : '端口未监听/不健康'),
    };
  },

  },
};
