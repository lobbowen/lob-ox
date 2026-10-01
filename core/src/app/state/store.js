'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');

function createStore(deps) {
  const g = deps || {};
  const record = g.record;
  const fields = g.fields;
  const mainStore = g.mainStore;
  const upgradeHold = g.upgradeHold;
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  const events = () => (typeof g.getEvents === 'function' ? g.getEvents() : null);
  const instances = () => (typeof g.getInstances === 'function' ? g.getInstances() : null);
  const views = () => (typeof g.getViews === 'function' ? g.getViews() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  let lastStateBody = null;

  function writeState(force) {
    try {
      const snap = views().status();
      const updatedAt = snap.updatedAt;
      snap.updatedAt = null;
      const body = JSON.stringify(snap, null, 2);
      if (!force && body === lastStateBody) return;
      lastStateBody = body;
      snap.updatedAt = updatedAt;
      const dir = path.dirname(config().stateFile);
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(config().stateFile, JSON.stringify(snap, null, 2), { mode: 0o600 });
    } catch (e) {
      const l = logger();
      if (l && l.error) l.error('state write failed: ' + e.message);
    }
  }

  function loadState() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(config().stateFile, 'utf8'));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        const l = logger();
        if (l && l.warn) l.warn('state load failed（按空状态继续）: ' + ((e && e.message) || e));
      }
    }
    if (raw && typeof raw === 'object') try {
      if (raw.desired === 'stopped' || raw.desired === 'running') {
        const m = reg();
        const registryHasSource = !!(m && m._loadedFromDisk);
        if (!registryHasSource) fields.setDesired(raw.desired);
      }
      if (typeof raw.restartCount === 'number') record.fieldOf('restartCount', raw.restartCount, true);
      if (typeof raw.startupFailWindowStart === 'number' || raw.startupFailWindowStart === null) record.fieldOf('startupFailWindowStart', raw.startupFailWindowStart, true);
      if (typeof raw.startupFailCount === 'number') record.fieldOf('startupFailCount', raw.startupFailCount, true);
      if (typeof raw.lastFailure === 'string' || raw.lastFailure === null) record.procFieldOf('lastFailure', raw.lastFailure, true);
      if (typeof raw.lastRestartAt === 'string' || raw.lastRestartAt === null) record.procFieldOf('lastRestartAt', raw.lastRestartAt, true);
      if (raw.upgradeHold === true) upgradeHold.enter();
      if (raw.shellHalted === true && typeof g.setShellHalted === 'function') g.setShellHalted(true);
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('state restore partial（字段级跳过，boot 仍继续）: ' + ((e && e.message) || e));
    }
    try { fields.setPhase('STOPPED'); } catch {}
  }

  function migrateMainRecord() {
    try {
      const im = instances();
      if (!im || !Array.isArray(im.instances)) return;
      const idx = im.instances.findIndex((i) => i.id === 'main');
      if (idx < 0) return;
      const main = im.instances[idx];
      const f = mainStore.dshMainFile();
      if (f && !fs.existsSync(f)) {
        mainStore.writeDshMain({
          guardian: main.guardian === true,
          remoteMode: main.remoteEnabled === true ? (main.frpEnabled === true ? 'wan' : 'lan') : 'off',
          remoteToken: String(main.remoteToken || ''),
        });
      }
      im.instances.splice(idx, 1);
      if (im.save) { try { im.save(); } catch {} }
      const l = logger();
      if (l && l.info) l.info('[main] 概念清分：main 记录已迁出 instances.json → dsh-main.json');
      const ev = events();
      if (ev) ev.append('main_meta_migrated', {});
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_migrateMainRecord: ' + (e && e.message));
    }
  }

  return { writeState, loadState, migrateMainRecord };
}

module.exports = { createStore };
