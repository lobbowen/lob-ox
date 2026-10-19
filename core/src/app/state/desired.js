'use strict';

const fs = require('node:fs');
const { writeDurable } = require('../../platform/util/fs');
const pmClient = require('../../platform/contract/pm-client');

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
  const setShellHalted = typeof g.setShellHalted === 'function' ? g.setShellHalted : null;
  const shellHalted = () => (typeof g.getShellHalted === 'function' ? g.getShellHalted() === true : false);
  const tick = () => { if (typeof g.tick === 'function') g.tick(); };
  const stopProcess = (why) => { if (typeof g.stopProcess === 'function') g.stopProcess(why); };

  function setDesired(v) {
    if (v !== 'running' && v !== 'stopped') return { error: 'invalid desired' };
    if (v === 'running') { const it = intents(); if (it) it.register('start'); setCrashHalted(false); }
    if (v === 'running' && fields.observedOnly() && fields.accessors.adoptedPid.get() !== null) {
      fields.setObservedOnly(false);
      fields.setPhase('STOPPED');
    }
    if (v === 'stopped' && fields.observedOnly() && fields.accessors.adoptedPid.get() !== null) {
      stopProcess('desired_stopped');
    }
    // 进程所有权归壳：desired 变化必须同步给壳的进程表。
    // 壳的 heal_candidates 只捞 desired=running 的——不上报的话，
    // 用户在这里停止主 DSH，壳仍认为 desired=running，崩溃后会按自己的判据重拉，
    // 与内核「已停止」的意图直接冲突。此前这条上报是缺的，
    // 内核只能另立一套 guardian 判据在本地兜，于是同一语义有两处实现。
    //
    // 回报必须被消费：pm/set-desired 成功 ⇒ 壳活着且在做状态同步 ⇒
    // 这正是「壳让停」旧标记（shellHalted）的清除时机。
    // 此前 post() 的返回值被丢掉 ⇒ 静默失败无法分辨（§7.45：写操作必须确认生效）。
    // 而那与「失败类事件只记不消费」是同一条：pm_endpoint_unavailable /
    // pm_request_failed / pm_send_failed 反过来就是「壳活着」的判据。
    //
    // 为什么清 shellHalted：它在 shutdown()/shutdownAll() 里被写 true 并持久化
    // （session/shutdown.js:25,63），而 state 恢复时 store.js:59 会把它读回来，
    // 装配期的初始化（compose/core.js:116 的 false）被覆盖 ⇒ 一旦写过就是永久 true。
    // 后果：collaborators.js:139 的 _shellExitIntended = !!(_exitIntended() || _shellHalted)
    // 让内核永远认为「壳要让停」。真机实证：desired=running 与 shellHalted=true 并存。
    //
    // ⚠️ id 用 'dsh-main' 而**不是** 'core'（层 0）：本函数管的是 **DSH 主实例**的期望
    // （:26-31 的 observedOnly / adoptedPid / stopProcess 全指向它），而壳进程表里 `core`
    // 那一行代表**内核进程**（register_core 的 core_desc().id = "core"，Priority::Core）。
    // 两个不同的东西共用一个 id ⇒ 壳会把「用户停了 DSH」读成「内核该停」⇒ healer
    // 重拉内核（§7.91：给字段加第二个写入方前，先核那个字段代表什么）。
    //
    // ⚠️ 前置：壳侧必须先有 `dsh-main` 行，否则壳的 set_desired（mod.rs:87-92）对未知
    // id **静默丢弃** ⇒ 那会带回「壳不知道 DSH 停了」这个已修好的冲突 ⇒ 故本条与壳侧
    // 建行必须同批——单改一侧比不改更坏（不改是冲突仍在，改一半是已修好的变坏）。
    const reported = pmClient.setDesired('dsh-main', v) === true;
    if (reported && shellHalted() && setShellHalted) {
      setShellHalted(false);
      try { events().append('shell_halt_cleared', { reason: 'shell_sync_ok', desired: v }); } catch {}
      try { const l = logger(); l && l.info && l.info('shellHalted 已清（壳状态同步成功回执）'); } catch {}
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
      writeDurable(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
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
