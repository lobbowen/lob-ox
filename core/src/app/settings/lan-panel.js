'use strict';

const netInfo = require('../../platform/os/netinfo');
const { verifyPersisted } = require('./access');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config: () => host.config,
      logger: () => host.logger,
      events: () => host.events,
      configPath: () => host.configPath,
      state: () => host.state,
      api: () => host.api,
      lanPanelStatus: () => host.lanPanelStatus(),
      apiRebind: () => host._apiRebind(),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    lanPanelStatus() {
      const d = depsOf(this);
      const enabled = d.config().apiHost === '0.0.0.0';
      const port = d.config().apiPort;
      const ips = [];
      if (enabled) {
        ips.push(...netInfo.lanAddresses());
        if (!ips.length) {
          d.logger() && d.logger().warn && d.logger().warn(
            "lan ips: 未枚举到可用局域网地址（platform=" + netInfo.PLATFORM +
            ", supported=" + netInfo.supported + "）"
          );
        }
      } else {
        ips.push("127.0.0.1");
      }
      const unique = [...new Set(ips)];
      return { enabled, host: d.config().apiHost, port, urls: unique.map((ip) => 'http://' + ip + ':' + port) };
    },

    setLanPanel(enabled) {
      const d = depsOf(this);
      try {
        const on = enabled === true;
        if (on && !(d.config() && d.config().apiAccessKey)) {
          return { ok: false, code: 'ACCESS_KEY_REQUIRED', error: '开启局域网访问前请先设置访问密钥（apiAccessKey），否则局域网内任意设备可无认证访问' };
        }
        const host = on ? '0.0.0.0' : '127.0.0.1';
        const changed = d.config().apiHost !== host;
        d.config().apiHost = host;
        let persistError = null;
        if (d.configPath()) {
          d.state().persistConfigPatch({ apiHost: host });
          persistError = verifyPersisted(d.configPath(), { apiHost: host });
          if (persistError) d.logger().error(persistError);
        }
        if (changed && d.api() && typeof d.api().close === 'function') d.apiRebind();
        if (d.events()) d.events().append('lan_panel_changed', { enabled: on });
        if (d.logger() && d.logger().info) d.logger().info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
        const panel = d.lanPanelStatus();
        if (persistError) return { ok: false, error: persistError, ...panel };
        return { ok: true, ...panel };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
