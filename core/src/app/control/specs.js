'use strict';

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

  function syncManagedRegistry() {
    const m = reg();
    if (!m) return;
    try {
      upsert(mainSpec());
      const _m = instances();
      const sandboxes = (_m && typeof _m.all === 'function' && _m.all()) || [];
      for (const inst of sandboxes) {
        if (inst.id === 'main' || inst.domain === 'native') continue;
        upsert(sandboxSpec(inst));
      }
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
