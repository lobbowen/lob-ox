'use strict';

const BASE_POOLS = {
  managed: { base: 20000, count: 4000 },
};
const DEFAULT_POOLS = Object.assign({}, BASE_POOLS);

const SEGMENT_POOL = Object.create(null);
const SEGMENT_ANCHOR = Object.create(null);

let _shared = null;
function bindShared(inst) { _shared = inst; }

function registerPools(pools) {
  if (pools && typeof pools === 'object') {
    Object.assign(DEFAULT_POOLS, pools);
    if (_shared && _shared._pools) Object.assign(_shared._pools, pools);
  }
  return Object.assign({}, DEFAULT_POOLS);
}

function registerSegment(role, pool) {
  if (role && typeof role === 'object' && !Array.isArray(role)) {
    for (const [name, target] of Object.entries(role)) {
      if (!name) continue;
      if (target && typeof target === 'object') {
        SEGMENT_POOL[name] = target.pool || 'managed';
        if (Number.isFinite(Number(target.anchor))) SEGMENT_ANCHOR[name] = Number(target.anchor);
      } else {
        SEGMENT_POOL[name] = target || 'managed';
      }
    }
  } else if (typeof role === 'string' && role) {
    SEGMENT_POOL[role] = (typeof pool === 'string' && pool) ? pool : 'managed';
  }
  return Object.assign({}, SEGMENT_POOL);
}

function rangeOf(pools, segment) {
  const pool = SEGMENT_POOL[segment] || 'managed';
  return pools[pool] || DEFAULT_POOLS[pool] || DEFAULT_POOLS.managed;
}

function anchorOffset(pools, segment) {
  const range = rangeOf(pools, segment);
  const explicit = SEGMENT_ANCHOR[segment];
  if (Number.isFinite(explicit) && explicit >= 0 && explicit < range.count) return explicit;
  const pool = SEGMENT_POOL[segment] || 'managed';
  const samePool = Object.keys(SEGMENT_POOL).filter((s) => (SEGMENT_POOL[s] || 'managed') === pool);
  const idx = samePool.indexOf(segment);
  const offset = (idx > 0 ? idx * 1000 : 0);
  return offset < range.count ? offset : 0;
}

function reservedPoolOf(pools, port) {
  const seen = new Set();
  for (const key of Object.keys(pools)) {
    const rng = pools[key];
    if (!rng || seen.has(rng.base + ':' + rng.count)) continue;
    seen.add(rng.base + ':' + rng.count);
    if (port >= rng.base && port < rng.base + rng.count) return key;
  }
  return null;
}

function capacityOf(pools, records) {
  const out = {};
  for (const [pool, rng] of Object.entries(pools)) {
    let used = 0;
    for (const r of records.values()) {
      if (r.port >= rng.base && r.port < rng.base + rng.count) used += 1;
    }
    const free = Math.max(0, rng.count - used);
    out[pool] = {
      base: rng.base, size: rng.count, used, free,
      utilization: rng.count > 0 ? Number((used / rng.count).toFixed(4)) : 0,
    };
  }
  return out;
}

function availableOf(pools, records, segment) {
  const pool = SEGMENT_POOL[segment] || 'managed';
  const cap = capacityOf(pools, records)[pool];
  return cap ? cap.free : rangeOf(pools, segment).count;
}

function snapshotOf(records) {
  const byRole = (fn) => [...records.values()].filter(fn).map((r) => r.port).sort((a, b) => a - b);
  return {
    fixed: Object.fromEntries([...records.values()].filter((r) => String(r.owner || '').startsWith('system:')).map((r) => [r.role, r.port])),
    user: byRole((r) => r.role === 'user'),
    allocated: byRole((r) => r.role !== 'user' && !String(r.role).startsWith('system:')),
  };
}

module.exports = {
  BASE_POOLS, DEFAULT_POOLS, SEGMENT_POOL,
  bindShared, registerPools, registerSegment,
  rangeOf, anchorOffset, reservedPoolOf, capacityOf, availableOf, snapshotOf,
};
