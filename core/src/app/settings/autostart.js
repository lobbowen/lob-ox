'use strict';

const platform = require('../../platform/os/index');

class HostService {
  constructor(opts) {
    this.opts = opts || {};
    this.logger = opts.logger || console;
    this.events = opts.events || null;
  }

  autostartStatus() {
    const st = platform.autostart.status();
    return { unit: st.unit || st.kind || 'n/a', gui: !!st.gui, on: !!st.on };
  }

  setAutostart(on) {
    const r = platform.autostart.setAutostart(!!on);
    if (this.events) this.events.append('autostart_changed', { enabled: !!on, ok: !!r.ok });
    if (this.logger && this.logger.info) this.logger.info('autostart -> ' + (on ? 'on' : 'off') + (r.errors && r.errors.length ? ' errors=' + r.errors.length : ''));
    return { ok: !!r.ok, errors: r.errors || [], ...this.autostartStatus() };
  }

}

module.exports = {
  HostService,
  methods: {
    autostartStatus() {
      return this.hostService.autostartStatus();
    },

    setAutostart(on) {
      return this.hostService.setAutostart(on);
    },
  },
};
