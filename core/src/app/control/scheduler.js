'use strict';

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
      mainSnapshot: () => host._mainStateSnapshot(),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  async tick() {
    const d = depsOf(this);
    return d.main().converge();
  },

  async _dshSuperviseOnce() {
    const d = depsOf(this);
    try {
      if (d.stopping()) return { ok: false, error: 'guard stopping' };
      if (d.exitIntended()) return { ok: false, error: 'exit intended' };
      await d.main().converge();
      try { d.control().syncInstancesView(); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('instances view sync: ' + ((e && e.message) || e)); }
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('[dsh] supervise 异常: ' + ((e && e.message) || e));
    }
    d.main().shadowHeartbeat();
    try {
      const now = Date.now();
      if (!d.readLastOrphanAuditAt() || now - d.readLastOrphanAuditAt() > 60000) {
        d.writeLastOrphanAuditAt(now);
        d.audit().orphan();
      }
    } catch (e) { d.logger() && d.logger().debug && d.logger().debug('orphan audit: ' + ((e && e.message) || e)); }
    if (d.eventHub()) { try { await d.eventHub().sync(); } catch (e) { d.logger() && d.logger().debug && d.logger().debug('eventHub sync: ' + ((e && e.message) || e)); } }
    // 存活 = 进程还在（childAlive / adoptedAlive）；不是端口、不是 HTTP。
    const snap = d.mainSnapshot();
    const alive = !!(snap && (snap.childAlive || snap.adoptedAlive));
    const ph = d.state().phase();
    return {
      ok: alive,
      error: alive ? null
        : ph === 'FAILED' ? '启动反复失败：已停止自动重启，等待人工重试'
          : ph === 'STARTING' ? '启动窗口内进程已退出，等待重启' : '进程未运行',
    };
  },

  },
};
