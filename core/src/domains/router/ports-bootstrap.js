'use strict';

const { shared: portsShared } = require('../../platform/service/ports');
const { OWNER_PREFIXES } = require('./port-segments');

const path = require('node:path');
const fs = require('node:fs');
const { writeAtomic } = require('../../platform/util/fs');

function ensurePorts({ swDir, logger }) {
  const log = logger || console;
  try {
    const oldP = path.join(swDir, 'ports.json');
    const newP = path.join(swDir, 'ports-router.json');
    portsShared.migrateByOwnerPrefix(oldP, newP, OWNER_PREFIXES);
    const provFile = path.join(swDir, 'providers.json');
    if (fs.existsSync(provFile)) {
      const provs = JSON.parse(fs.readFileSync(provFile, 'utf8'));
      let target = { records: [] };
      try { if (fs.existsSync(newP)) target = JSON.parse(fs.readFileSync(newP, 'utf8')); } catch {}
      const byOwner = {};
      for (const rec of target.records || []) byOwner[rec.owner] = rec.port;
      let changed = false;
      const push = (owner, port, role) => { if (port && byOwner[owner] === undefined) { target.records.push({ port, role, owner, createdAt: Date.now() }); byOwner[owner] = port; changed = true; } };
      for (const p of (provs.providers || [])) {
        if (p.kind !== 'proxy') continue;
        for (const inst of (p.instances || [])) push('proxy:' + (inst.keyId || inst.key), inst.port, 'proxyInstance');
        push('providerApi:' + p.id, p.apiPort, 'providerApi');
      }
      if (changed) {
        fs.mkdirSync(path.dirname(newP), { recursive: true });
        writeAtomic(newP, JSON.stringify(target, null, 2), { mode: 0o600 });
      }
    }
    const cnt = JSON.parse(fs.readFileSync(newP, 'utf8')).records || [];
    log.info('[router-daemon] 迁移+重建：ports-router.json 就绪 records=' + cnt.length);
    return { records: cnt.length };
  } catch (err) {
    log.error('[router-daemon] 迁移异常(保留旧文件): ' + ((err && err.message) || err));
    return { records: 0, error: err };
  }
}

module.exports = { ensurePorts };
