'use strict';

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      state() { return host.state; },
      config() { return host.config; },
      mChild() { return host._mChild(); },
      mAdoptPid() { return host._mAdoptPid(); },
      mPhase() { return host._mPhase(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

const methods = {
  dshMainView() {
    const d = depsOf(this);
    const m = d.state().readMainMeta();
    const cfg = d.config();
    const cmd = Array.isArray(cfg.command) ? cfg.command.slice() : [];
    return {
      id: 'main',
      name: '主实例',
      port: Number(cfg.targetPort || 3080),
      command: cmd,
      domain: 'native',
      kind: 'native',
      guardian: m.guardian,
      remoteMode: m.remoteMode,
      remoteToken: m.remoteToken,
      unitName: null,
      state: {
        running: Boolean(d.mChild() || d.mAdoptPid()),
        phase: typeof d.mPhase === 'function' ? d.state().phase() : undefined,
        pid: d.mChild() ? d.mChild().pid : d.mAdoptPid(),
      },
    };
  },
};

module.exports = { methods };
