'use strict';

// daemon 探活（probe）：经 ctl 端口监听者的 cmdline 判定独立 daemon 是否在运行。
// 守卫探测到 daemon 在跑就不再内嵌启动（避免双占 ctl 口），只做监督。
// 导出形态 { methods }；实现体经按 host 缓存的惰性 deps（WeakMap）取事实。
const pidlook = require('../../platform/os/pidlookup');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) { d = { config: () => host.config, ctl: () => host.ctl }; DEPS.set(host, d); }
  return d;
}

module.exports = {
  methods: {
    /** 独立 router-daemon 是否在运行（探测 ctl 端口监听者 cmdline）。 */
    _routerDaemonActive() {
      const d = depsOf(this);
      try {
        const pid = pidlook.findListeningPid(d.ctl().routerPort());
        if (!pid) return false;
        // 匹配前必须归一化分隔符：路径字面量是 "/"，而 Windows 的 cmdline 是反斜杠，
        //   直接 indexOf 永远 -1，会认不出 daemon 已在跑而重复拉起。
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('router-daemon') >= 0 || cmd.indexOf('service-daemon') >= 0 || cmd.indexOf('/domains/router/daemon.js') >= 0;
      } catch { return false; }
    },

    /** lan-daemon 模式是否启用：config.lanDaemon 是结构性部署选择（壳写配置，无面板入口、不对用户
     *  暴露）——true 时 lan 由独立 daemon 承载（ctl 通道），否则内嵌 LanManager。 */
    lanDaemonEnabled() { const d = depsOf(this); const cfg = d.config(); return !!(cfg && cfg.lanDaemon === true); },

    _lanDaemonActive() {
      const d = depsOf(this);
      try {
        const pid = pidlook.findListeningPid(d.ctl().lanPort());
        if (!pid) return false;
        // 同 router：归一化分隔符后再与 "/" 字面量比较。
        const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
        return cmd.indexOf('lan-daemon') >= 0 || cmd.indexOf('/domains/relay/daemon.js') >= 0;
      } catch { return false; }
    },
  },
};
