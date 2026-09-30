'use strict';

// 用户意图写入工厂（真 ctor 注入）：可只 require 本模块 + 假 deps 直测。

const fs = require('node:fs');
const { writeAtomic } = require('../../platform/util/fs');

function createDesired(deps) {
  const g = deps || {};
  const fields = g.fields;
  const store = g.store;
  const intents = () => (typeof g.getIntents === 'function' ? g.getIntents() : null);
  const events = () => (typeof g.getEvents === 'function' ? g.getEvents() : null);
  const configPath = () => (typeof g.getConfigPath === 'function' ? g.getConfigPath() : null);
  // 换名别名表与 config.normalize 同源（app/settings/domain-config 声明，装配期注入，B2-4）：
  //   写盘清理由字典驱动，不在本文件硬编码键名。
  const configAliases = () => (typeof g.getConfigAliases === 'function' ? (g.getConfigAliases() || []) : []);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  const setCrashHalted = typeof g.setCrashHalted === 'function' ? g.setCrashHalted : () => {};
  const setManualRestart = typeof g.setManualRestart === 'function' ? g.setManualRestart : () => {};
  const tick = () => { if (typeof g.tick === 'function') g.tick(); };
  const stopProcess = (why) => { if (typeof g.stopProcess === 'function') g.stopProcess(why); };

  /** 设置用户期望运行态（/start、/stop）。 */
  function setDesired(v) {
    if (v !== 'running' && v !== 'stopped') return { error: 'invalid desired' };
    // 显式「启动」是用户意图，不受守护开关短路限制。
    if (v === 'running') { const it = intents(); if (it) it.register('start'); setCrashHalted(false); }
    if (v === 'running' && fields.phase() === 'OBSERVED') {
      fields.setObservedOnly(false);      // 从观测模式转正
      fields.setPhase('STOPPED');         // 交给 switch 立即重新调和
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

  /*  config.json 补丁持久化；原子写 0600。返回落盘成败：无 configPath 或写失败均 false
   *  （调用方据此如实上报，不再靠回读比对核验）。
   *  既有文件读/解析失败时拒绝写回（fail-closed）：瞬时读错后继续写会把 apiAccessKey 等全部键抹掉。
   *  文件缺失（ENOENT）视为首启空配置，照常写入。 */
  function persistConfigPatch(patch) {
    const p = configPath();
    if (!p) return false; // 无落点 = 未持久化
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
      // 旧键清理由别名驱动（B2-4）：仅当新键已在盘上才删旧键——旧键是唯一意图时提前删=静默丢失。
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
