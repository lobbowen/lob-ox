'use strict';

// relay 端口槽位仲裁（IO 层）：把 platform 通用池的 claimSlot/回收/占用标记收口为具名函数，ops.js 只经本模块操作端口。
// require 即申报 relay 段（域知识留在域内，DS-G4）。

require('./port-segments');
const registry = require('../../platform/service/ports').shared;

/** 逻辑段到池范围：main 无绑定时的建议槽位派生自池定义，禁止池外硬编码。 */
function rangeOf(segment) { return registry.rangeOf(segment); }

/** 确定性申请一个 relay 槽位。segment 段名（relay）、owner 归属（relay:<id>）。
 *  @param opts { preferred, bindingPreferred, onBindingLost, configPath }
 *  @returns {Promise<{port:number}|{conflict:true,port?:number}|null>} */
async function claim(segment, owner, opts) {
  const o = opts || {};
  return registry.claimSlot(segment, owner, {
    preferred: o.preferred,
    bindingPreferred: !!o.bindingPreferred,
    onBindingLost: o.onBindingLost,
    reclaimCmdMark: 'lan-daemon.js',
    // configPath 为空时 reclaimCfg=''，probe.reclaimByCmdMark 按 fail-closed 不回收：
    // 宁可留占用走冲突分支，也不按 cmdMark 全量误杀同名进程。
    reclaimCfg: o.configPath || '',
    waitMs: 8000,
  });
}

/** 按 owner 释放端口注册（用 unregister 而非 release(port)：绑定与具体端口号解耦）。 */
function releaseOwner(owner) {
  try { registry.unregister(owner); } catch {}
}

/** 删除同一 owner 下除 keepPort 外的重复残留记录（真源唯一）。 */
function purgeDuplicates(owner, keepPort) {
  for (const rec of registry.list()) {
    // 带 owner 比对：防 list 与 release 之间 TOCTOU 误删他人记录。
    if (rec.owner === owner && rec.port !== keepPort) {
      try { registry.release(rec.port, rec.owner); } catch {}
    }
  }
}

/** 确保端口已在注册表标记占用（幂等）。 */
function ensureMarked(port, owner) {
  if (!registry.isRegistered(port)) registry.allocateMark(port, 'relay', owner);
}

module.exports = { rangeOf, claim, releaseOwner, purgeDuplicates, ensureMarked };
