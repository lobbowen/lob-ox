'use strict';

const ports = require('../../platform/service/ports').shared;

function call(fn, dflt) { return typeof fn === 'function' ? fn() : dflt; }

function orphanAudit(deps) {
  const g = deps || {};
  if (call(g.getStopping, false)) return;
  const now = Date.now();
  const reg = call(g.getManagedObjects, null);
  const issues = [];
  try {
    const daemons = [
      { kind: 'router-daemon', port: g.getCtl().routerPort(), active: () => g.getDaemons().routerActive(), managed: () => g.getDaemons().managed(), want: () => g.getConfig().routerAutostart === true },
      { kind: 'lan-daemon', port: g.getCtl().lanPort(), active: () => g.getDaemons().lanActive(), managed: () => g.getDaemons().lanManaged(), want: () => g.getDaemons().enabled() },
    ];
    for (const d of daemons) {
      if (!d.active()) continue;
      if (!d.want() && !d.managed()) {
        issues.push({ kind: d.kind, port: d.port, why: '端口被监听但本守卫期望停止且无管理锁（异主/残留 daemon）' });
      }
    }
    try {
      const insts = call(g.getInstances, null);
      const ids = new Set(insts ? insts.map((i) => i.id) : []);
      for (const rec of ports.list()) {
        if (!String(rec.owner || '').startsWith('inst:')) continue;
        const id = String(rec.owner).slice(5);
        if (!ids.has(id)) issues.push({ kind: 'port-registration', owner: rec.owner, port: rec.port, why: '端口登记 owner 指向已不存在的实例（残留登记）' });
      }
    } catch (e) {
      const l = call(g.getLogger, null);
      if (l && l.warn) l.warn('orphan-scan 端口登记段失败: ' + ((e && e.message) || e));
    }
    try {
      const staleMs = Math.max(3 * (g.getConfig().tickIntervalMs || 5000), 30000);
      for (const e of (reg && typeof reg.list === 'function') ? reg.list() : []) {
        if (e.id === 'main') continue;
        if (e.phase !== 'running' && e.phase !== 'starting') continue;
        const ob = e.lastObserved;
        if (ob && ob.ok === false && ob.at && now - new Date(ob.at).getTime() > staleMs) {
          issues.push({ kind: e.kind, id: e.id, why: '期望运行但观测长期失联（幽灵登记）' });
        }
      }
    } catch (err) {
      const l = call(g.getLogger, null);
      if (l && l.warn) l.warn('orphan-scan 幽灵登记段失败: ' + ((err && err.message) || err));
    }
    if (issues.length === 0) return;
    const key = issues.map((i) => i.kind + ':' + (i.id || i.port || i.owner)).join('|');
    const lastKey = call(g.getLastKey, null);
    const lastAt = call(g.getLastAt, null);
    if (lastKey === key && lastAt && now - lastAt < 10 * 60 * 1000) return;
    if (typeof g.setLastKey === 'function') g.setLastKey(key);
    if (typeof g.setLastAt === 'function') g.setLastAt(now);
    const events = call(g.getEvents, null);
    if (events && events.append) { try { events.append('orphan_audit', { issues, at: new Date().toISOString() }); } catch {} }
    const detail = issues.map((i) => i.kind + (i.id ? ':' + i.id : '') + (i.port ? ':' + i.port : '') + (i.owner ? ':' + i.owner : '') + ' ' + i.why).join(' | ');
    const logger = call(g.getLogger, null);
    logger && logger.warn && logger.warn('[orphan] 游离对象自检: ' + detail);
  } catch (e) {
    const logger = call(g.getLogger, null);
    logger && logger.warn && logger.warn('[orphan] 自检异常: ' + ((e && e.message) || e));
  }
}

module.exports = { orphanAudit };
