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
      mLastProbeOk: () => host._mLastProbeOk(),
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
    return {
      ok: d.mLastProbeOk() === true,
      error: d.mLastProbeOk() ? null : (d.state().phase() === 'STOPPED' ? '未运行' : '端口未监听/不健康'),
    };
  },

  },
};
