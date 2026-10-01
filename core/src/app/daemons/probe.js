'use strict';

const pidlook = require('../../platform/os/pidlookup');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) { d = { config: () => host.config, ctl: () => host.ctl }; DEPS.set(host, d); }
  return d;
}

module.exports = {
  methods: {
    _routerDaemonActive() {
      const d = depsOf(this);
      try {
        const pid = pidlook.findListeningPid(d.ctl().routerPort());
        if (!pid) return false;
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('router-daemon') >= 0 || cmd.indexOf('service-daemon') >= 0 || cmd.indexOf('/domains/router/daemon.js') >= 0;
      } catch { return false; }
    },

    lanDaemonEnabled() { const d = depsOf(this); const cfg = d.config(); return !!(cfg && cfg.lanDaemon === true); },

    _lanDaemonActive() {
      const d = depsOf(this);
      try {
        const pid = pidlook.findListeningPid(d.ctl().lanPort());
        if (!pid) return false;
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('lan-daemon') >= 0 || cmd.indexOf('/domains/relay/daemon.js') >= 0;
      } catch { return false; }
    },
  },
};
