'use strict';

// app/facade/lan.js —— lan(relay) 域只读门面（写动作 setRemoteMode/setRemoteToken/lanFrpc/syncFrpc 在 app/domain-actions/lan.js）。
// 只读白名单：listLan（读触发对账，见 FACADE_EXCEPTIONS）/ frpStatus；daemon 模式经 43108 ctl 委托，内嵌模式走 LanManager 只读方法。
// 导出契约 module.exports = { methods }，方法经按 host 缓存的惰性 deps 取事实。
const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = { daemons: () => host.daemons, ctl: () => host.ctl, lan: () => host.lan };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = { methods: {

  // 远程控制委托：全部转发给 LanManager；daemon 监督模式经 43108 ctl 委托（异步），本地模式走 LanManager（同步）。
  // 令牌收敛：listLan 输出必须剔除 token/dshToken —— /lan-access 允许 LAN/私网 Host 访问，直出会把 DSH 会话令牌泄漏给局域网，权威仍在 DshTokenService。
  // 远程访问令牌的明文也不在此下发：它是实例意图字段，只随 /instances 的回环分支交给本机面板（api/domains/instances.js#decorate）。
  // remote（projectRemoteView 产物）为后端单一推导视图 {mode,ready,accessUrl,reasons}，不含机密，整段放行给 UI。返回形如 {items,addresses}。
  listLan() {
    const d = depsOf(this);
    // 白名单外显：只放行结构字段与 inject 状态、remote 视图；任何令牌字段都不外传。
    const sanitize = (r) => {
      if (!r || !r.items) return r;
      return { items: r.items.map((it) => {
        const out = {
          id: it.id, name: it.name, dshPort: it.dshPort, wanPort: it.wanPort,
          running: !!it.running,
          // 令牌状态（布尔，不泄明文）：UI 据此引导，明文的查看/修改走 /instances 的回环分支。
          tokenSet: !!String(it.token || '').trim(),
          remote: it.remote || null,
        };
        if (it.inject) {
          out.inject = {
            tokenSet: !!it.inject.tokenSet,
            cookieReady: !!it.inject.cookieReady,
            lastOkAt: it.inject.lastOkAt || null,
            lastError: it.inject.lastError || null,
            lastErrorAt: it.inject.lastErrorAt || null,
          };
        }
        return out;
      }), addresses: r.addresses || [] };
    };
    if (d.daemons().enabled() /* daemon 启用即 ctl */) return d.ctl().lanCall('list').then(sanitize).catch(() => ({ items: [], addresses: [] }));
    try { return sanitize(d.lan().list()); } catch { return { items: [], addresses: [] }; }
  },

  frpStatus() {
    const d = depsOf(this);
    if (d.daemons().enabled() /* daemon 启用即 ctl */) return d.ctl().lanCall('frpStatus');
    return d.lan().frpStatus();
  },
} };
