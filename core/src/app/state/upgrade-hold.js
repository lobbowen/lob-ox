'use strict';

// 升级 hold 工厂（真 ctor 注入）。
// hold 标志位落宿主瞬态字段（controller/facade 直读 _upgradeHold），经 getHold/setHold 注入。

const pidlook = require('../../platform/os/pidlookup');

function createUpgradeHold(deps) {
  const g = deps || {};
  const fields = g.fields;
  const store = () => (typeof g.getStore === 'function' ? g.getStore() : null);
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const intents = () => (typeof g.getIntents === 'function' ? g.getIntents() : null);
  const tick = () => { if (typeof g.tick === 'function') g.tick(); };
  const stopProcess = (why) => { if (typeof g.stopProcess === 'function') g.stopProcess(why); };
  const setHold = typeof g.setHold === 'function' ? g.setHold : () => {};
  const setSince = typeof g.setSince === 'function' ? g.setSince : () => {};

  function enter() {
    setHold(true);
    setSince(Date.now());
    const child = fields.child();
    const adoptPid = fields.adoptPid();
    const targetAlive =
      (child && child.exitCode === null && child.signalCode === null) ||
      (adoptPid !== null && adoptPid !== undefined && pidlook.isAlive(adoptPid));
    if (targetAlive) {
      stopProcess('upgrade'); // 落实“先停后装”
    } else if (fields.phase() !== 'STOPPED') {
      fields.setPhase('STOPPED');
      const s = store();
      if (s) s.writeState();
    }
  }

  async function enterAsync() {
    // 先捕获目标引用：enter() 内部 stopProcess 会清空 child/adoptedPid，故在调用前取出。
    const refs = { child: fields.child(), adoptedPid: fields.adoptPid() };
    enter();
    if (refs.child && refs.child.exitCode === null && refs.child.signalCode === null) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        refs.child.once('exit', done);
        setTimeout(done, config().stopGraceMs + 5000);
      });
      return;
    }
    if (refs.adoptedPid && pidlook.isAlive(refs.adoptedPid)) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        const start = Date.now();
        const check = () => {
          if (!pidlook.isAlive(refs.adoptedPid)) return done();
          if (Date.now() > start + config().stopGraceMs + 5000) return done();
          setTimeout(check, 200);
        };
        check();
      });
    }
  }

  function exit(explicit) {
    setHold(false);
    setSince(null);
    if (explicit) { const it = intents(); if (it) it.register('upgrade-resume'); }
    tick();
  }

  return { enter, enterAsync, exit };
}

module.exports = { createUpgradeHold };
