'use strict';

// app/control/specs.js —— 受管对象申报工厂（真 ctor 注入）：createSpecs(deps) 自己持有
// 申报/注册实现，只 require 本模块 + 假 deps 即可直测。

const os = require('node:os');
const path = require('node:path');
const { daemonScript } = require('../daemons/scripts');

function createSpecs(deps) {
  const g = deps || {};
  const state = () => (typeof g.getState === 'function' ? g.getState() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  const instances = () => (typeof g.getInstances === 'function' ? g.getInstances() : null);
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const ctl = () => (typeof g.getCtl === 'function' ? g.getCtl() : null);
  const daemons = () => (typeof g.getDaemons === 'function' ? g.getDaemons() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);

  /** main(dsh) 申报为管家注册项。guardian 不申报（B2-2）：守护开关权威在 dsh-main.json，消费者直读源。 */
  function mainSpec() {
    return {
      kind: 'dsh', id: 'main', name: '主实例',
      desired: state().desired() === 'stopped' ? 'stopped' : 'running',
      ownership: {
        ports: [{ role: 'dsh-main', port: Number(config().targetPort || 3080) }],
        rootPath: path.join(os.homedir(), '.dsh'),
        processMode: 'spawn',
      },
    };
  }

  /** 单个沙箱实例申报。不申报 desired（B2-1）也不申报 guardian（B2-2）：运行意图没有第二
   *  落点，守护开关权威在实例记录 inst.guardian（supervise 直读）；相位不进应然面。 */
  function sandboxSpec(inst) {
    if (!inst || !inst.id) return null;
    let rootPath = null;
    const im = instances();
    try { if (im && typeof im.sandboxRoot === 'function') rootPath = im.sandboxRoot(inst); } catch {}
    return {
      kind: 'sandbox-instance', id: inst.id, name: String(inst.name || inst.id),
      ownership: {
        ports: [{ role: 'inst', port: Number(inst.port) }],
        rootPath,
        unit: 'dsh-web@' + inst.id,
        processMode: 'systemd',
      },
    };
  }

  /** 申报或更新（存在->update 应然；否则 register）。spec.desired 若给出必须是意图源的投影
   *  （main=state.desired、域 B=config 业务条件），不得由 phase 推导（契约 M-1）；
   *  沙箱实例有意不申报 desired——update 见 undefined 即跳过，目录项不落第二意图源。 */
  function upsert(spec) {
    const m = reg();
    if (!m || !spec) return;
    try {
      const existing = m.get(spec.id);
      if (existing) m.update(spec.id, { desired: spec.desired, name: spec.name, ownership: spec.ownership });
      else m.register(spec);
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_upsertManaged(' + (spec && spec.id) + '): ' + (e && e.message));
    }
  }

  function unregister(id) {
    const m = reg();
    if (!m || !id) return;
    try { m.unregister(id); } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_unregisterManaged(' + id + '): ' + (e && e.message));
    }
  }

  /** 启动对齐：main + 全部沙箱 + router/lan daemon 申报入册（幂等）。 */
  function syncManagedRegistry() {
    const m = reg();
    if (!m) return;
    try {
      upsert(mainSpec());
      const _m = instances();
      const sandboxes = (_m && typeof _m.all === 'function' && _m.all()) || [];
      for (const inst of sandboxes) {
        if (inst.id === 'main' || inst.domain === 'native') continue;
        // 沙箱 spec 只带身份/所有权（B2-1/B2-2）：load() 后的 state.phase 是实然快照，
        // 观测对齐路径对目录的 desired/guardian 零写权。
        upsert(sandboxSpec(inst));
      }
      // 目录全域不持 guardian（B2-2，契约 G-1 收口形态）；域 B 的 desired 由配置业务条件驱动。
      const c = ctl();
      upsert({
        kind: 'router-daemon', id: 'router-daemon', name: '智能路由 daemon',
        desired: config().routerAutostart === true ? 'running' : 'stopped',
        ownership: {
          daemonScript: daemonScript('router'),
          ports: [{ role: 'ctl', port: c.routerPort() }],
          processMode: 'daemon',
        },
      });
      const d = daemons();
      upsert({
        kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon',
        desired: d.enabled() ? 'running' : 'stopped',
        ownership: {
          daemonScript: daemonScript('lan'),
          ports: [{ role: 'ctl', port: c.lanPort() }],
          processMode: 'daemon',
        },
      });
      const l = logger();
      if (l && l.info) l.info('[registry] 受管对象已申报: ' + m.list().map((o) => o.kind + ':' + o.id).join(','));
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_syncManagedRegistry: ' + (e && e.message));
    }
  }

  return { mainSpec, sandboxSpec, upsert, unregister, syncManagedRegistry };
}

module.exports = { createSpecs };
