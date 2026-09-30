'use strict';

// 端口池与逻辑段的纯核心（无 IO / 无定时 / 无进程）：少数物理池 + 逻辑段到池的映射。
// 逻辑段名仅决定从哪个池取号，具体段名是域知识，不在本平台模块出现（门禁 DS-G4）：由域在装配期经 registerSegment(role, pool) 申报。

const BASE_POOLS = {
  managed: { base: 20000, count: 4000 },      // 通用共享池（默认 20000-23999）
};
const DEFAULT_POOLS = Object.assign({}, BASE_POOLS);

// 逻辑段（role）-> 物理池；未申报段名一律回退通用池 managed（前向兼容）。
const SEGMENT_POOL = Object.create(null);
// 段 -> 池内显式锚点（可选，由域申报）：给定后「同池各段起点」不依赖申报顺序。
const SEGMENT_ANCHOR = Object.create(null);

// 共享单例引用（在 index.js 构造后回填）：使模块级 registerPools 能同步已存在实例。
let _shared = null;
function bindShared(inst) { _shared = inst; }

/** 注册接口：申报额外物理池（含 base/count）；就地扩展 DEFAULT_POOLS 并同步实例。 */
function registerPools(pools) {
  if (pools && typeof pools === 'object') {
    Object.assign(DEFAULT_POOLS, pools);
    if (_shared && _shared._pools) Object.assign(_shared._pools, pools);
  }
  return Object.assign({}, DEFAULT_POOLS);
}

/** 注册接口：把逻辑段名映射到物理池；可传映射对象或 (role, pool)。 */
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

/** 逻辑段到池定义（未注册段名回退 managed 池）。 */
function rangeOf(pools, segment) {
  const pool = SEGMENT_POOL[segment] || 'managed';
  return pools[pool] || DEFAULT_POOLS[pool] || DEFAULT_POOLS.managed;
}

/** 逻辑段在所属池内的锚点偏移：域申报 anchor 优先，否则同池段序 x 1000。 */
function anchorOffset(pools, segment) {
  const range = rangeOf(pools, segment);
  const explicit = SEGMENT_ANCHOR[segment];
  if (Number.isFinite(explicit) && explicit >= 0 && explicit < range.count) return explicit;
  const pool = SEGMENT_POOL[segment] || 'managed';
  const samePool = Object.keys(SEGMENT_POOL).filter((s) => (SEGMENT_POOL[s] || 'managed') === pool);
  const idx = samePool.indexOf(segment);
  const offset = (idx > 0 ? idx * 1000 : 0);
  return offset < range.count ? offset : 0; // 偏移不得超出池容量（否则回退池首）
}

/** 端口所属保留池名；不属任何池返回 null（同 base:count 的池只报首个）。 */
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

/** 池容量视图：每池 { base, size, used, free, utilization }。 */
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

/** 逻辑段当前可用量。 */
function availableOf(pools, records, segment) {
  const pool = SEGMENT_POOL[segment] || 'managed';
  const cap = capacityOf(pools, records)[pool];
  return cap ? cap.free : rangeOf(pools, segment).count;
}

/** 全部端口快照（固定/用户/分配）。 */
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
