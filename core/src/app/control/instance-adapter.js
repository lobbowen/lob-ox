'use strict';

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      stopping: () => host._stopping,
      exitIntended: () => host._exitIntended(),
      instances: () => host.instances,
      logger: () => host.logger,
      control: () => host.control,
      managedObjects: () => host.managedObjects,
      syncSandboxRegistryEntry: (entry) => host._syncSandboxRegistryEntry(entry),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    async _sandboxSuperviseOnce(entry) {
      const d = depsOf(this);
      if (d.stopping()) return { ok: false, error: 'guard stopping' };
      if (d.exitIntended()) return { ok: false, error: 'exit intended' };
      if (entry && d.instances() && typeof d.instances().supervise === 'function') {
        try {
          await d.instances().supervise(entry.id);
        } catch (e) {
          d.logger() && d.logger().warn && d.logger().warn('sandbox supervise(' + entry.id + '): ' + ((e && e.message) || e));
        }
      }
      let st = null;
      try {
        if (entry && d.instances() && typeof d.instances().probeInstance === 'function') {
          st = d.instances().probeInstance(entry.id);
        }
      } catch (e) {
        d.logger() && d.logger().warn && d.logger().warn('sandbox probe(' + (entry && entry.id) + '): ' + ((e && e.message) || e));
      }
      const running = !!(st && st.running);
      try { d.syncSandboxRegistryEntry(entry); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox entry sync: ' + ((e && e.message) || e)); }
      return { ok: running, error: running ? null : '沙箱实例未运行' };
    },
    _syncSandboxRegistryEntry(entry) {
      const d = depsOf(this);
      if (!entry || !d.managedObjects() || !d.instances()) return;
      if (d.managedObjects().get(entry.id) !== entry) return;
      const inst = d.instances().find(entry.id);
      if (!inst) {
        d.control().unregister(entry.id);
        return;
      }
      try { d.control().upsert(d.control().sandboxSpec(inst)); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox upsert: ' + ((e && e.message) || e)); }
      // 实例域相位（U-5 后只有 STOPPED/INSTALLING/STARTING/RUNNING/FAILED）；老落盘里的 'BACKOFF'（等级退避）
      // 已删除 ⇒ 归一为 'failed'（停靠、等人工重试），与主链 app/state/phase.js 的 BACKOFF→failed 同向。
      const map = { STOPPED: 'stopped', INSTALLING: 'installing', STARTING: 'starting', RUNNING: 'running', BACKOFF: 'failed', FAILED: 'failed' };
      const ph = map[(inst.state && inst.state.phase) || 'STOPPED'] || 'stopped';
      try {
        if (entry.phase !== ph) d.managedObjects().setPhase(entry.id, ph);
      } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox setPhase: ' + ((e && e.message) || e)); }
    },
  },
};
