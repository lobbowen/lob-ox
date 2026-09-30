'use strict';

// 管家面板局域网访问开关门面。
// 导出形态 { methods }，方法经 this 协作。
// 写入契约（B2-4 归一）：config.json 持久化唯一入口 = state.persistConfigPatch
//   （fail-closed + 原字节保留 + 别名字典清理），本层与 access.js 同口径「写后读回核验」。
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
      // 真实可访问地址：只给局域网内设备真正能访问的地址——「走默认路由的真实出口网卡」的
      // IPv4，过滤虚拟网桥(virbr*/veth*/docker*/br-*)。不能直接调 ip(iproute2)：Linux 专有，
      // macOS/Windows 上抛异常被吞、ips 恒空且不报错；须经 platform/os/netinfo 三平台实现。
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
      // 去重保持稳定顺序
      const unique = [...new Set(ips)];
      return { enabled, host: d.config().apiHost, port, urls: unique.map((ip) => 'http://' + ip + ':' + port) };
    },

    /** 开=面板绑定 0.0.0.0（局域网可访问，经 apiHost 白名单限制为局域网/本机）；关=仅绑定 127.0.0.1（本机可访问）。 */
    setLanPanel(enabled) {
      const d = depsOf(this);
      try {
        const on = enabled === true;
        // 开 LAN 必须已配置出回环访问密钥（apiAccessKey）：访问密钥层只对「已配置 key」的
        // 非回环请求生效，未配置时局域网内任意设备可零认证驱动写 API。故显式要求先设 key。
        if (on && !(d.config() && d.config().apiAccessKey)) {
          // code 供 API 层区分「客户端可修正的前置条件失败」（400）与「持久化异常」（500）。
          return { ok: false, code: 'ACCESS_KEY_REQUIRED', error: '开启局域网访问前请先设置访问密钥（apiAccessKey），否则局域网内任意设备可无认证访问' };
        }
        const host = on ? '0.0.0.0' : '127.0.0.1';
        const changed = d.config().apiHost !== host;
        d.config().apiHost = host;
        // 落盘失败必须如实上报（与 access.js 口径一致）：内存是运行期权威，故仍完成重绑与事件，
        //   但把「未落盘」透传（api/domains/guard.js 据此回 500）。否则面板显示已切换、重启后回旧值。
        let persistError = null;
        if (d.configPath()) {
          // 单一写口 + 写后读回核验（与 access.js 同口径）：persistConfigPatch 内部
          //   fail-closed（读/解析失败拒写并保留原字节），核验失败原因由 verifyPersisted 给出。
          d.state().persistConfigPatch({ apiHost: host });
          persistError = verifyPersisted(d.configPath(), { apiHost: host });
          if (persistError) d.logger().error(persistError);
        }
        if (changed && d.api() && typeof d.api().close === 'function') d.apiRebind();
        if (d.events()) d.events().append('lan_panel_changed', { enabled: on });
        if (d.logger() && d.logger().info) d.logger().info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
        // 只取一次快照：lanPanelStatus 会枚举局域网地址（平台子进程），且成功/失败返回的
        //   host/urls 必须同源，否则两次调用可能给出不一致结果。
        const panel = d.lanPanelStatus();
        if (persistError) return { ok: false, error: persistError, ...panel };
        return { ok: true, ...panel };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
