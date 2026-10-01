'use strict';

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
      stopProcess('upgrade');
    } else if (fields.phase() !== 'STOPPED') {
      fields.setPhase('STOPPED');
      const s = store();
      if (s) s.writeState();
    }
  }

  async function enterAsync() {
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
