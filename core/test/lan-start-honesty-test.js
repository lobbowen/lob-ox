#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : ''));
};

const { registerAll } = require(path.join(ROOT, 'src', 'app', 'control', 'adapters.js'));
const { ManagedLifecycle } = require(path.join(ROOT, 'src', 'app', 'control', 'entry.js'));
const { createProjection } = require(path.join(ROOT, 'src', 'app', 'control', 'projection.js'));
const { applyMainPort } = require(path.join(ROOT, 'src', 'app', 'main', 'port-rederive.js'));

function mgrOf(lcs) {
  const map = new Map(lcs.map((l) => [l.id, l]));
  return { register: (l) => map.set(l.id, l), get: (id) => map.get(id) || null };
}

(async () => {
  {
    const mk = (lan) => {
      const mgr = mgrOf([]);
      registerAll(mgr, { lan, supervisor: null, logger: null });
      return mgr.get('lan');
    };
    let lc = mk({ reconcile: async () => ({ ok: false, error: '隧道不可达' }), syncFrpc: () => ({ ok: true }), status: () => ({}) });
    let r = await lc.start();
    check('E-1 reconcile 如实失败 → start 必须 ok:false（旧版恒 ok:true，把失败咽成"已启动"）',
      r.ok === false && String(r.error).includes('隧道不可达'), JSON.stringify(r));

    lc = mk({ reconcile: async () => ({ ok: true }), syncFrpc: () => ({ ok: false, error: 'frpc not installed', needInstall: true }) });
    r = await lc.start();
    check('E-2 frpc 同步失败 → start ok:false 且 needInstall 如实上抛（对齐 frpAction 既有失败语义）',
      r.ok === false && String(r.error).includes("frpc not installed"), JSON.stringify(r));

    lc = mk({ reconcile: async () => ({ ok: true }), syncFrpc: () => ({ ok: true, proxies: 2, running: true }) });
    r = await lc.start();
    check('E-3 两路都成功 → ok:true 且带真实 proxies 计数',
      r.ok === true && r.proxies === 2, JSON.stringify(r));

    const { LanManager } = require(path.join(ROOT, 'src', 'domains', 'relay', 'ops.js'));
    check('E-4 reconcile 失败路径 resolve 出 {ok:false,error} 而非 reject/undefined（诚实上抛的源头保证）',
      /return\s*\{\s*ok:\s*false,\s*error:/.test(String(LanManager.prototype.reconcile)), '源码判据');
    check('E-5 syncFrpc 无 frp 时如实 ok:false（旧版直接 return undefined，被上层当成功）',
      /if\s*\(!this\.frp\)\s*return\s*\{\s*ok:\s*false/.test(String(LanManager.prototype.syncFrpc)), '源码判据');
  }

  {
    const lcBad = new ManagedLifecycle({ id: 'instances', kind: 'instances', status: () => null });
    const lcGood = new ManagedLifecycle({ id: 'instances', kind: 'instances', status: () => ({ count: 3, running: 2 }) });
    const mgr = { get: (id) => (id === 'instances' ? (lcBad._probe === false ? lcGood : lcBad) : null) };
    let cur = lcBad;
    const pr = createProjection({ getLifecycleManager: () => ({ get: (id) => cur }), getState: () => null });
    cur = lcBad; pr.syncInstancesView();
    check('E-6 登记表读数不可用 → healthy:false + 明确 error（旧版写死 healthy:true，面板与事实相反）',
      lcBad.healthy === false && !!lcBad.error, JSON.stringify({ h: lcBad.healthy, e: lcBad.error }));
    cur = lcGood; pr.syncInstancesView();
    check('E-7 读数可得 → healthy:true 且 running 视图进入 running 相',
      lcGood.healthy === true && lcGood.error === null && lcGood.phase === 'running', JSON.stringify({ h: lcGood.healthy, p: lcGood.phase }));
  }

  {
    const mkHost = (syncLanThrows) => ({
      config: { targetPort: 3080, targetHost: '127.0.0.1', healthUrl: 'http://127.0.0.1:3080/' },
      logger: { warn: (m) => { mkHost.logs.push(String(m)); } },
      logs: mkHost.logs,
      events: { appended: [], append(t, d) { this.appended.push({ t, d }); } },
      daemons: { syncLanState() { if (syncLanThrows) throw new Error('relay 写失败'); } },
    });
    mkHost.logs = [];
    const ports = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
    const shared = ports.shared;
    const origRegister = shared.register; const origRelease = shared.release;
    shared.register = () => {}; shared.release = () => {};
    try {
      const h1 = mkHost(false);
      const ok1 = applyMainPort(h1, 3100, 123);
      const ev1 = h1.events.appended.find((e) => e.t === 'main_port_adopted');
      check('E-8 LAN 同步成功 → 事件 lanSync:"ok" 且文案称"已更正"',
        ok1 === true && ev1 && ev1.d.lanSync === 'ok' && /已更正/.test(mkHost.logs[mkHost.logs.length - 1]), JSON.stringify(ev1 && ev1.d));

      mkHost.logs = [];
      const h2 = mkHost(true);
      const ok2 = applyMainPort(h2, 3200, 456);
      const ev2 = h2.events.appended.find((e) => e.t === 'main_port_adopted');
      const lastLog = mkHost.logs[mkHost.logs.length - 1] || '';
      check('E-9 LAN 同步失败 → 不得声称"已更正 relay 目标"，且失败单独可见（旧版 catch{} 吞错仍打"已更正"）',
        ok2 === true && ev2 && ev2.d.lanSync === 'failed'
        && !/已更正注册与 relay 目标/.test(lastLog) && /relay\/LAN.*同步失败/.test(mkHost.logs.join('\n')), JSON.stringify({ ev: ev2 && ev2.d, log: lastLog }));
    } finally { shared.register = origRegister; shared.release = origRelease; }
  }

  process.exit(results.every(Boolean) ? 0 : 1);
})();
