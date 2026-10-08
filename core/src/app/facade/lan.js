'use strict';

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

  listLan() {
    const d = depsOf(this);
    const sanitize = (r) => {
      if (!r || !r.items) return r;
      return { items: r.items.map((it) => {
        const out = {
          id: it.id, name: it.name, dshPort: it.dshPort, wanPort: it.wanPort,
          running: !!it.running,
          tokenSet: !!it.tokenSet,
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
    if (d.daemons().enabled() ) return d.ctl().lanCall('list').then(sanitize).catch(() => ({ items: [], addresses: [] }));
    try { return sanitize(d.lan().list()); } catch { return { items: [], addresses: [] }; }
  },

  frpStatus() {
    const d = depsOf(this);
    if (d.daemons().enabled() ) return d.ctl().lanCall('frpStatus');
    return d.lan().frpStatus();
  },
} };
