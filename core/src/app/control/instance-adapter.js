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
      
      
      if (!running && st && st.portTaken) {
        const why = st.identityUnknown ? '端口监听者身份不可读' : '端口被非 DSH 进程占用';
        return { ok: false, error: '沙箱实例未运行：端口 ' + (entry && entry.port) + ' ' + why
          + '（pid=' + st.pid + '），不按本实例在跑处置' };
      }
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
      
      
      const map = { STOPPED: 'stopped', INSTALLING: 'installing', STARTING: 'starting', RUNNING: 'running', BACKOFF: 'failed', FAILED: 'failed' };
      const ph = map[(inst.state && inst.state.phase) || 'STOPPED'] || 'stopped';
      try {
        if (entry.phase !== ph) d.managedObjects().setPhase(entry.id, ph);
      } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox setPhase: ' + ((e && e.message) || e)); }
      
      try {
        const rc = Number(inst.state && inst.state.restartCount) || 0;
        if (entry.restartCount !== rc) d.managedObjects().setRestartCount(entry.id, rc);
      } catch (e) { d.logger() && d.logger().warn && d.logger().warn('sandbox setRestartCount: ' + ((e && e.message) || e)); }
    },
  },
};
