'use strict';

// 主机服务对接 -> 平台抽象层（src/platform/os/autostart），实现全部委托平台层。
// 三端能力以 capabilityProfile() 的 shellAutostart / shellSelfHeal 声明为准。

const platform = require('../../platform/os/index');

class HostService {
  constructor(opts) {
    this.opts = opts || {};
    this.logger = opts.logger || console;
    this.events = opts.events || null;
  }

  /* 服务链自启（systemd / macOS LaunchAgent / Windows schtasks） */
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

// 门面：{ methods } 导出，方法经 this 协作（委托 this.hostService）；HostService 保留在上。
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
