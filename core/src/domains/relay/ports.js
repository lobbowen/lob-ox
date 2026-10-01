'use strict';

require('./port-segments');
const registry = require('../../platform/service/ports').shared;

function rangeOf(segment) { return registry.rangeOf(segment); }

async function claim(segment, owner, opts) {
  const o = opts || {};
  return registry.claimSlot(segment, owner, {
    preferred: o.preferred,
    bindingPreferred: !!o.bindingPreferred,
    onBindingLost: o.onBindingLost,
    reclaimCmdMark: 'lan-daemon.js',
    // configPath 为空时 fail-closed 不回收：宁可留占用走冲突分支，也不按 cmdMark 误杀同名进程。
    reclaimCfg: o.configPath || '',
    waitMs: 8000,
  });
}

function releaseOwner(owner) {
  try { registry.unregister(owner); } catch {}
}

function purgeDuplicates(owner, keepPort) {
  for (const rec of registry.list()) {
    if (rec.owner === owner && rec.port !== keepPort) {
      try { registry.release(rec.port, rec.owner); } catch {}
    }
  }
}

function ensureMarked(port, owner) {
  if (!registry.isRegistered(port)) registry.allocateMark(port, 'relay', owner);
}

module.exports = { rangeOf, claim, releaseOwner, purgeDuplicates, ensureMarked };
