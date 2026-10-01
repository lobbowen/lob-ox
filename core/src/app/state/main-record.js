'use strict';

function createMainRecord(deps) {
  const g = deps || {};
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  let fallback = null;
  const DEFAULTS = { restartCount: 0, startupFailWindowStart: null, startupFailCount: 0 };
  const buffered = new Map();

  function entryOf() {
    const m = reg();
    if (!m || typeof m.get !== 'function') return null;
    try { return m.get('main') || null; } catch { return null; }
  }

  function fallbackEntryOf() {
    if (!fallback) {
      fallback = {
        kind: 'dsh', id: 'main', name: '主实例',
        desired: 'running',
        ownership: { ports: [], rootPath: null, unit: null, daemonScript: null, processMode: 'spawn', meta: null },
        phase: 'stopped', lastObserved: null,
        startupFailWindowStart: null, startupFailCount: 0,
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

  function storeOf() {
    const e = entryOf();
    if (!e) return fallbackEntryOf();
    if (buffered.size) flushBuffered(e);
    return e;
  }

  function flushBuffered(e) {
    let changed = false;
    for (const [k, v] of buffered) {
      if (k in DEFAULTS && e[k] === DEFAULTS[k] && e[k] !== v) { e[k] = v; changed = true; }
    }
    buffered.clear();
    if (changed) persistCrashField();
  }

  function fieldOf(name, v, write) {
    const e = storeOf();
    if (write) {
      if (e === fallback && name in DEFAULTS) buffered.set(name, v);
      if (e[name] !== v) { e[name] = v; persistCrashField(); }
      return e;
    }
    return e[name];
  }

  function procFieldOf(name, v, write) {
    const e = storeOf();
    let p = e.process;
    if (!p) {
      p = e.process = {
        child: null, adoptedPid: null, adopted: false, observedOnly: false,
        startDeadline: null, restartAt: null, spawnBlockedUntil: null, missingNotified: false,
        lastFailure: null, lastRestartAt: null,
      };
    }
    if (write) { if (p[name] !== v) p[name] = v; return p; }
    return p[name];
  }

  return { entryOf, fallbackEntryOf, persistCrashField, storeOf, fieldOf, procFieldOf };
}

module.exports = { createMainRecord };
