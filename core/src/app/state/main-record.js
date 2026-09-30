'use strict';

// 状态基座的存储原语工厂（真 ctor 注入）：自己持有 fallback 存储与读写实现。

function createMainRecord(deps) {
  const g = deps || {};
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  let fallback = null;
  //  目录未就绪期（构造窗口/init 异常）对这些字段的直写会落在 fallback 对象上，entry 一旦出现
  //  就成了没人再读的孤儿稿——崩溃计数静默丢失（审计 #26）。故 fallback 期写值先记 here，
  //  storeOf 见到真 entry 时一次性回填；目录侧非缺省值（盘上真实数据）优先，草稿只补缺。
  const DEFAULTS = { restartCount: 0, backoffLevel: 0, backoffUntil: null, crashWindowStart: null, crashWindowRestarts: 0 };
  const buffered = new Map();

  /** 目录 main 项（未初始化/异常返回 null）。 */
  function entryOf() {
    const m = reg();
    if (!m || typeof m.get !== 'function') return null;
    try { return m.get('main') || null; } catch { return null; }
  }

  /** 构造期 fallback 存储（目录初始化前/异常时的统一读写口）。 */
  function fallbackEntryOf() {
    if (!fallback) {
      fallback = {
        kind: 'dsh', id: 'main', name: '主实例',
        // 不带 guardian（B2-2/B2-3）：目录 entry 形态已无该键，守护开关权威在 dsh-main.json。
        desired: 'running',
        ownership: { ports: [], rootPath: null, unit: null, daemonScript: null, processMode: 'spawn', meta: null },
        phase: 'stopped', lastObserved: null,
        backoffLevel: 0, backoffUntil: null, crashWindowStart: null, crashWindowRestarts: 0,
        restartCount: 0, startedAt: null, lastTransitionAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        process: null,
      };
    }
    return fallback;
  }

  function persistCrashField() {
    const m = reg();
    try {
      if (m && typeof m.persistCrashState === 'function') m.persistCrashState();
      else if (m && typeof m._save === 'function') m._save();
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('persistCrashField: ' + ((e && e.message) || e));
    }
  }

  /** 状态存储解析：目录 main entry 优先，构造期回退到 fallback；真 entry 首见时回填草稿。 */
  function storeOf() {
    const e = entryOf();
    if (!e) return fallbackEntryOf();
    if (buffered.size) flushBuffered(e);
    return e;
  }

  /** 一次性回填：仅当目录侧仍是 createEntry 缺省值才覆盖——盘上真实数据优先，
   *   fallback 只是目录未就绪期的暂存稿，从不反向压制已加载的计数。 */
  function flushBuffered(e) {
    let changed = false;
    for (const [k, v] of buffered) {
      if (k in DEFAULTS && e[k] === DEFAULTS[k] && e[k] !== v) { e[k] = v; changed = true; }
    }
    buffered.clear();
    if (changed) persistCrashField();
  }

  /** write=true 时值变化即落盘并返回 entry，否则读值。 */
  function fieldOf(name, v, write) {
    const e = storeOf();
    if (write) {
      if (e === fallback && name in DEFAULTS) buffered.set(name, v);
      if (e[name] !== v) { e[name] = v; persistCrashField(); }
      return e;
    }
    return e[name];
  }

  /** write=true 时返回 process 对象，否则读值。 */
  function procFieldOf(name, v, write) {
    const e = storeOf();
    let p = e.process;
    if (!p) {
      p = e.process = {
        child: null, adoptedPid: null, adopted: false, observedOnly: false,
        startDeadline: null, restartAt: null, spawnBlockedUntil: null, missingNotified: false,
        failStreak: 0, lastProbeAt: null, lastProbeOk: null, lastProbeHttpOk: null,
        lastFailure: null, lastRestartAt: null,
      };
    }
    if (write) { if (p[name] !== v) p[name] = v; return p; }
    return p[name];
  }

  return { entryOf, fallbackEntryOf, persistCrashField, storeOf, fieldOf, procFieldOf };
}

module.exports = { createMainRecord };
