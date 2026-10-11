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


  },
};
