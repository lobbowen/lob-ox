'use strict';

require('./port-segments');
const registry = require('../../platform/service/ports').shared;

const ROUTER_LEDGER = 'ports-router.json';

function rangeOf(segment) { return registry.rangeOf(segment); }

function _reservedByOtherLedger(owner) {
  try {
    const recs = registry.readAll([ROUTER_LEDGER]);
    const set = new Set();
    for (const r of recs) {
      if (r && r.port != null && r.owner && r.owner !== owner && r.owner !== 'relay:') {
        set.add(Number(r.port));
      }
    }
    return set.size ? set : null;
  } catch { return null; }
}

async function claim(segment, owner, opts) {
  const o = opts || {};
  const reservedPorts = o.reservedPorts || _reservedByOtherLedger(owner);
  return registry.claimSlot(segment, owner, {
    preferred: o.preferred,
    bindingPreferred: !!o.bindingPreferred,
    
    
    reservedPorts: reservedPorts || undefined,
    onBindingLost: o.onBindingLost,
    
    
    
    
    reclaimCmdMark: 'domains/relay/daemon.js',
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
