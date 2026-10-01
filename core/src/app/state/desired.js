'use strict';

const fs = require('node:fs');
const { writeAtomic } = require('../../platform/util/fs');

function createDesired(deps) {
  const g = deps || {};
  const fields = g.fields;
  const store = g.store;
  const intents = () => (typeof g.getIntents === 'function' ? g.getIntents() : null);
  const events = () => (typeof g.getEvents === 'function' ? g.getEvents() : null);
  const configPath = () => (typeof g.getConfigPath === 'function' ? g.getConfigPath() : null);
  const configAliases = () => (typeof g.getConfigAliases === 'function' ? (g.getConfigAliases() || []) : []);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  const setCrashHalted = typeof g.setCrashHalted === 'function' ? g.setCrashHalted : () => {};
  const setManualRestart = typeof g.setManualRestart === 'function' ? g.setManualRestart : () => {};
  const tick = () => { if (typeof g.tick === 'function') g.tick(); };
  const stopProcess = (why) => { if (typeof g.stopProcess === 'function') g.stopProcess(why); };

  function setDesired(v) {
    if (v !== 'running' && v !== 'stopped') return { error: 'invalid desired' };
    if (v === 'running') { const it = intents(); if (it) it.register('start'); setCrashHalted(false); }
    if (v === 'running' && fields.phase() === 'OBSERVED') {
      fields.setObservedOnly(false);
      fields.setPhase('STOPPED');
    }
    if (v === 'stopped' && fields.phase() === 'OBSERVED' && fields.observedOnly()) {
      stopProcess('desired_stopped');
    }
    if (fields.desired() !== v) {
      fields.setDesired(v);
      const ev = events();
      if (ev) ev.append('desired_changed', { desired: v });
      store.writeState();
    }
    tick();
    return { ok: true, desired: fields.desired() };
  }

  function requestRestart() {
    if (fields.desired() === 'stopped') {
      const ev = events();
      if (ev) ev.append('manual_restart_requested', { ignored: 'desired=stopped' });
      return { ok: false, error: 'desired=stopped，请先 /start' };
    }
    setManualRestart(true);
    setCrashHalted(false);
    const it = intents(); if (it) it.register('restart');
    const ev = events();
    if (ev) ev.append('manual_restart_requested', {});
    tick();
    return { ok: true };
  }

    // 既有 config.json 读/解析失败时拒绝写回（fail-closed）：瞬时读错后继续写会抹掉 apiAccessKey 等全部键；ENOENT 视为首启。
  function persistConfigPatch(patch) {
    const p = configPath();
    if (!p) return false;
    const abort = (m) => {
      const l = logger();
      if (l && l.warn) l.warn('config persist aborted (fail-closed): ' + m);
      const ev = events();
      if (ev) { try { ev.append('config_persist_aborted', { reason: m }); } catch {} }
      return false;
    };
    try {
      let cur = {};
      let raw = null;
      try { raw = fs.readFileSync(p, 'utf8'); }
      catch (e) {
        if (!e || e.code !== 'ENOENT') return abort('read failed: ' + ((e && e.message) || e));
      }
      if (raw !== null) {
        try {
          cur = JSON.parse(raw);
          if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('root is not an object');
        } catch (e) {
          return abort('parse failed, original bytes preserved: ' + ((e && e.message) || e));
        }
      }
      Object.assign(cur, patch);
      for (const [from, to] of configAliases()) {
        if (cur[from] !== undefined && cur[to] !== undefined) delete cur[from];
      }
      writeAtomic(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('config persist failed: ' + e.message);
      return false;
    }
  }

  return { setDesired, requestRestart, persistConfigPatch };
}

module.exports = { createDesired };
