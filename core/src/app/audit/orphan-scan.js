'use strict';

// 游离对象自检（orphan-scan）—— 低频（~60s）自检，只写日志 + orphan_audit 事件
// （同指纹 10min 抑制），绝不强杀/释放（异主隔离红线）。
// 实现主体 orphanAudit(deps) 只经惰性取值函数取用宿主事实；唯一调用方是 audit/collaborator.js 工厂。

const ports = require('../../platform/service/ports').shared;

/** 惰性取值：fn 不是函数时回退 dflt（host 兼容外壳与协作方工厂共用同一条实现）。 */
function call(fn, dflt) { return typeof fn === 'function' ? fn() : dflt; }

/** 游离对象自检实现（deps：getConfig/getLogger/getEvents/getInstances/getManagedObjects/
 *  getCtl/getDaemons/getStopping + getLastKey/setLastKey/getLastAt/setLastAt）。
 *  扫描维度：daemon 在监听但本守卫既无期望也无管理锁（异主/残留）；
 *  端口登记 owner=inst:* 而实例已不存在；目录项期望 running/starting 但观测长期失联（幽灵登记）。 */
function orphanAudit(deps) {
  const g = deps || {};
  if (call(g.getStopping, false)) return;
  const now = Date.now();
  const reg = call(g.getManagedObjects, null);
  const issues = [];
  try {
    // want = 「本守卫是否有意让它活着」，只取持久化/结构性判据本身；目录 entry 的 desired 是它的
    //   派生镜像（specs 每拍由同一源重推），读镜像会把「镜像未及更新」误判成游离。
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
    // 端口登记残留检测
    try {
      const insts = call(g.getInstances, null);
      const ids = new Set(insts ? insts.map((i) => i.id) : []);
      for (const rec of ports.list()) {
        if (!String(rec.owner || '').startsWith('inst:')) continue;
        const id = String(rec.owner).slice(5);
        if (!ids.has(id)) issues.push({ kind: 'port-registration', owner: rec.owner, port: rec.port, why: '端口登记 owner 指向已不存在的实例（残留登记）' });
      }
    } catch (e) {
      // 整段静默会让「端口登记残留」这一维永久不可见（扫描器看起来在跑、其实从未扫到）。
      const l = call(g.getLogger, null);
      if (l && l.warn) l.warn('orphan-scan 端口登记段失败: ' + ((e && e.message) || e));
    }
    // 幽灵登记观测线索：期望运行但实然长期失联（main 由收敛接管，跳过避免噪声）
    try {
      const staleMs = Math.max(3 * (g.getConfig().probeIntervalMs || 5000), 30000);
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
    if (lastKey === key && lastAt && now - lastAt < 10 * 60 * 1000) return; // 同指纹抑制
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
