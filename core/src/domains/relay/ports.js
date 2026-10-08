'use strict';

require('./port-segments');
const registry = require('../../platform/service/ports').shared;
// RL-4：relay 与 router 共享 managed 端口池（20000-23999），但各自用独立账本文件
// （relay=ports.json，router=ports-router.json）。PortRegistry.isTaken 只看自己的文件，
// 于是「仅登记未监听」的 router 端口会被 relay 同段 claim 抢走 ⇒ 双方都 bind 时 EADDRINUSE。
// 故 claim 前先查 router 账本：该端口若已被 router 持有则直接冲突返回，交给上层换口。
const ROUTER_LEDGER = 'ports-router.json';

function rangeOf(segment) { return registry.rangeOf(segment); }

// 跨账本防撞（审计 RL-4）：router 与 relay 共用 managed 池（20000-23999）却各自用独立账本
// 文件（router=ports-router.json，relay=ports.json）。PortRegistry._records 按文件隔离，
// isRegistered/isTaken 没有跨文件可见性，bindable() 只在端口"当前正在监听"时才挡得住。
// 触发链：router 先以"仅登记未监听"占用某端口 → relay 的 bindable(thatPort) 仍成功 →
// relay 绑定 → router 后续 bind 撞 EADDRINUSE。故 claim 前从 router 账本收集已被占的端口，
// 作为 reservedPorts 交给分配器；分配器在 free-scan / preferred-claim 阶段直接跳过这些端口。
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
    // RL-4：跨账本防撞。router caller 不传 reservedPorts（分配器跳过该检查，行为不变）；
    // 仅 relay 传入 router 账本已占端口，free-scan/preferred-claim 跳过 ⇒ 不会抢 router 的端口。
    reservedPorts: reservedPorts || undefined,
    onBindingLost: o.onBindingLost,
    // 审计 RL-3：reclaimCmdMark 必须出现在 relay daemon 的真实命令行里，否则 pgrepList 永远匹配不到 ⇒ 回收是死代码。
    // relay daemon 经 runtime.js 以 `node .../domains/relay/daemon.js -c <cfg>` 拉起（scripts.js:8），
    // 命令行含 `domains/relay/daemon.js`（与 process.js#reclaimOrphans 用的 _cmdMarks 同源），故此处用同一标记。
    // configPath 为空时 fail-closed 不回收：宁可留占用走冲突分支，也不按 cmdMark 误杀同名进程（reclaimByCmdMark 内部也已要求 cfgStr 必填）。
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
