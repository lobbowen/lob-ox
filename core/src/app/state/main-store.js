'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');

function createMainStore(deps) {
  const g = deps || {};
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  let live = null;
  let corrupt = false;

  function dshMainFile() {
    try { return path.join(path.dirname(config().stateFile), 'dsh-main.json'); } catch { return null; }
  }

  function registryFileName() {
    try {
      const b = path.basename(config().stateFile || 'state.json', '.json');
      return b === 'state' ? 'managed-objects.json' : (b + '.managed-objects.json');
    } catch { return 'managed-objects.json'; }
  }

  function readDshMainFile() {
    try {
      const f = dshMainFile();
      if (f && fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        corrupt = false;
        return {
          guardian: j.guardian === true,
          remoteMode: legacyRemoteMode(j),
          remoteToken: String(j.remoteToken || ''),
        };
      }
    } catch (e) {
      corrupt = true;
      const l = logger();
      if (l && l.warn) l.warn('dsh-main.json 读/解析失败，写回将被拒绝直至显式重设 remoteToken: ' + ((e && e.message) || e));
    }
    return { guardian: false, remoteMode: 'off', remoteToken: '' };
  }

  function legacyRemoteMode(j) {
    if (j.remoteMode === 'lan' || j.remoteMode === 'wan') return j.remoteMode;
    if (j.remoteEnabled === true && j.frpEnabled === true) return 'wan';
    if (j.remoteEnabled === true) return 'lan';
    return 'off';
  }

  function readDshMain() {
    if (live) return live;
    live = readDshMainFile();
    return live;
  }

  
  function writeDshMain(meta) {
    const m = meta || {};
    if (!live) live = readDshMainFile();
    if (corrupt && !(typeof m.remoteToken === 'string' && m.remoteToken)) {
      const l = logger();
      if (l && l.warn) l.warn('writeDshMain: 文件损坏态，拒绝以默认值覆盖写回');
      return;
    }
    corrupt = false;
    Object.assign(live, m);
    const f = dshMainFile();
    if (!f) return;
    try {
      const cur = readDshMain();
      const merged = Object.assign({}, cur, m);
      const dir = path.dirname(f);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        guardian: merged.guardian === true,
        remoteMode: merged.remoteMode === 'lan' || merged.remoteMode === 'wan' ? merged.remoteMode : 'off',
        remoteToken: String(merged.remoteToken || ''),
      }, null, 2);
      writeAtomic(f, body, { mode: 0o600 });
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('writeDshMain: ' + ((e && e.message) || e));
    }
  }

  return { dshMainFile, registryFileName, readDshMain, readDshMainFile, writeDshMain };
}

module.exports = { createMainStore };
