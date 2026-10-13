'use strict';

// R2/D.11-P3-10：原 depsOf 注入 12 个依赖而 tick() 只用 main 一个，audit /
// eventHub / readLastOrphanAuditAt / writeLastOrphanAuditAt / mainSnapshot 五个注入点
// 全死，连带 decide.js 的 _mainStateSnapshot（19 字段快照）唯一消费者不可达。
//
// 现按实际需要重建：tick 只依赖 main；orphanAudit 改为由 BeatScheduler.afterTick
// 驱动（见 compose/domains.js 的注册），按 5 分钟节流，不再借道 tick。

const ORPHAN_AUDIT_INTERVAL_MS = 5 * 60 * 1000;

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      main: () => host.main,
      audit: () => host.audit,
      stopping: () => host._stopping === true,
      readLastOrphanAuditAt: () => host._lastOrphanAuditAt,
      writeLastOrphanAuditAt: (v) => { host._lastOrphanAuditAt = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  async tick() {
    const d = depsOf(this);
    return d.main().converge();
  },

  // 游离对象自检。此前全库无调用点（D.7-P1-3 记录的「写了但忘了接线」），
  // 异主 daemon 占端口、端口登记指向已删实例、幽灵受管对象三类问题从不被检测。
  // 现由 BeatScheduler.afterTick 每拍调用，内部按 ORPHAN_AUDIT_INTERVAL_MS 节流。
  async orphanAudit() {
    const d = depsOf(this);
    if (d.stopping()) return;
    const now = Date.now();
    const last = d.readLastOrphanAuditAt();
    if (typeof last === 'number' && now - last < ORPHAN_AUDIT_INTERVAL_MS) return;
    d.writeLastOrphanAuditAt(now);
    const audit = d.audit();
    if (audit && typeof audit.orphan === 'function') {
      try { await audit.orphan(); }
      catch (e) {
        const lg = d.main() && d.main().logger;
        lg && lg.warn && lg.warn('orphanAudit: ' + ((e && e.message) || e));
      }
    }
  },


  },
};
