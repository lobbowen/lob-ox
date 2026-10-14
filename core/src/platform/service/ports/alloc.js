'use strict';

const fs = require('node:fs');
const core = require('./core');
const probe = require('./probe');
const lease = require('../../util/lease');

const XLOCK_TIMEOUT_MS = 3000;
const XLOCK_STALE_MS = 15000;

class PortAllocator {
  constructor(registry) { this._registry = registry; this._xrel = null; }

  async claimSlot(rangeKey, owner, opts) {
    const o = opts || {};
    const r = this._registry;
    const range = o.range || r.rangeOf(rangeKey);
    if (!range) throw new Error('ports.claimSlot: 未知端口段 ' + rangeKey);
    await this._acquireAlloc();
    try {
      return await this._claimSlotLocked(rangeKey, owner, range, o);
    } finally {
      this._releaseAlloc();
    }
  }

  
  async _acquireAlloc() {
    const r = this._registry;
    let waited = 0;
    for (;;) {
      if (lease.acquireSync(r, '_allocLock')) break;
      await new Promise((res) => setTimeout(res, 10));
      waited += 10;
      
      if (waited >= XLOCK_TIMEOUT_MS) { throw new Error('ports.claimSlot: 进程内分配锁等待超时（' + XLOCK_TIMEOUT_MS + 'ms），拒绝在无锁状态下分配'); }
    }
    this._xrel = await this._acquireXLock();
    r._syncFromDisk();
  }

  _releaseAlloc() {
    // 释放必须走 lease.releaseSync —— 直接写 _allocLock=false 是第二条释放路径，
    // 与 pool._mutate 的 lease.acquireSync 配对时会把布尔标志恢复成「非持有」却绕过
    // 唯一原语。现统一为一对原语，杜绝「两条释放路径」造成的状态分叉。
    require('../../util/lease').releaseSync(this._registry, '_allocLock');
    const rel = this._xrel; this._xrel = null;
    if (rel) { try { rel(); } catch {  } }
  }

  
  async _acquireXLock() {
    const f = String(this._registry._file || '') + '.alloc.lock';
    const deadline = Date.now() + XLOCK_TIMEOUT_MS;
    for (;;) {
      let fh = null;
      try {
        fh = fs.openSync(f, 'wx');
        fs.writeSync(fh, String(process.pid));
        fs.closeSync(fh); fh = null;
        let unlocked = false;
        return () => { if (unlocked) return; unlocked = true; try { fs.unlinkSync(f); } catch {  } };
      } catch (e) {
        if (fh) { try { fs.closeSync(fh); } catch {  } }
        if (e && e.code === 'EEXIST') {
          
          
          
          let recyclable = false;
          try { recyclable = lease.lockRecyclable(f, XLOCK_STALE_MS); } catch { recyclable = false; }
          if (recyclable) { try { fs.unlinkSync(f); } catch {  } }
          if (Date.now() < deadline) { await new Promise((res) => setTimeout(res, 25)); continue; }
          throw new Error('ports.claimSlot: 跨进程分配锁等待超时（' + XLOCK_TIMEOUT_MS + 'ms），拒绝在无锁状态下分配');
        }
        throw new Error('ports.claimSlot: 跨进程分配锁获取失败（' + (e && e.code ? e.code : e) + '），拒绝在无锁状态下分配');
      }
    }
  }

  async _confirmRegister(port, rangeKey, owner) {
    const r = this._registry;
    // 本函数全程在 _acquireAlloc() 持有的 _allocLock 内运行（由 claimSlot/allocate 的
    // try/finally 保证），因此直接写账本而不再经 pool._mutate —— 后者是同步函数，
    // 在此 await 期间调用会因锁已被本协程持有而抛错。互斥由 acquire/release 一对
    // 原语在本协程内闭合，不再依赖标志位猜测重入。
    r._records.set(port, { port, role: rangeKey, owner, createdAt: Date.now() });
    r._save();
    // 确认窗口的语义是「给对端 listener 起来的机会」；360ms 硬编码与同文件其它
    // 等待预算（waitMs 默认 6000/2500）口径不一，导致确认超时远早于真实可用。
    const confirmDeadline = Date.now() + (Number(this._confirmWaitMs) || 2500);
    for (let i = 0; Date.now() < confirmDeadline; i++) {
      if (!(await probe.loopbackListening(port))) return true;
      if (probe.listeningPid(port) === process.pid) return true;
      await new Promise((res) => setTimeout(res, 120));
    }
    const rec = r._records.get(port);
    if (rec && rec.owner === owner) { r._records.delete(port); r._save(); }
    return false;
  }

  async _claimSlotLocked(rangeKey, owner, range, o) {
    const r = this._registry;
    const bound = r.byOwner(owner);
    if (bound) {
      const got = await this._tryClaim(bound, owner, rangeKey, o);
      if (got) return Object.assign({ owner, segment: rangeKey, binding: true }, got);
      const alt = await this._allocFreeCore(rangeKey, range, owner, o);
      if (alt) {
        this._notifyLost(o, owner, bound, alt.port);
        return Object.assign({ owner, segment: rangeKey, binding: true, bindingLost: true, from: bound }, alt);
      }
      return this._conflict(owner, rangeKey, 'binding-occupied-and-pool-full', bound);
    }
    if (o.preferred) {
      const got = await this._tryClaim(o.preferred, owner, rangeKey, o);
      if (got) return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: !!o.bindingPreferred }, got);
      if (o.bindingPreferred) {
        const alt = await this._allocFreeCore(rangeKey, range, owner, o);
        if (alt) {
          this._notifyLost(o, owner, o.preferred, alt.port);
          return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: true, bindingLost: true, from: o.preferred }, alt);
        }
        return this._conflict(owner, rangeKey, 'binding-preferred-occupied-and-pool-full', o.preferred);
      }
    }
    const free = await this._allocFreeCore(rangeKey, range, owner, o);
    if (free) return Object.assign({ owner, segment: rangeKey }, free);
    return this._conflict(owner, rangeKey, 'pool-full', null);
  }

  _notifyLost(o, owner, from, to) {
    if (o.onBindingLost) { try { o.onBindingLost({ owner, from, to }); } catch {} }
  }

  _conflict(owner, rangeKey, reason, port) {
    const cap = this._registry.capacity()[core.SEGMENT_POOL[rangeKey] || 'managed'] || null;
    return Object.assign({ owner, segment: rangeKey, conflict: true, reason, error: 'port-pool-exhausted', capacity: cap }, port ? { port } : {});
  }

  _register(port, rangeKey, owner) {
    const r = this._registry;
    if (!r._records.has(port)) {
      r._records.set(port, { port, role: rangeKey, owner, createdAt: Date.now() });
      r._save();
    }
  }

  async _waitFree(port, owner, ms) {
    const r = this._registry;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!(await r.isTaken(port, owner))) return true;
      await new Promise((res) => setTimeout(res, 200));
    }
    return !(await r.isTaken(port, owner));
  }

  async _tryClaim(port, owner, rangeKey, o) {
    if (!port) return null;
    const r = this._registry;
    const reserved = o.reservedPorts instanceof Set ? o.reservedPorts : null;
    
    if (reserved && reserved.has(Number(port))) return null;
    // R6：联合避让。preferred/binding 路径同样要避开 sibling 已占用的端口，
    // 否则「指定端口」这条路仍是跨进程双分配的口子。
    const joint = r._foreignPorts();
    const rec = joint.get(Number(port));
    if (probe.listeningPid(port) === process.pid) { this._register(port, rangeKey, owner); return { port, mode: 'self-listening' }; }
    if (rec && rec.owner !== owner) return null;
    const reused = !!(rec && rec.owner === owner);
    if (!(await r.isTaken(port, owner))) { this._register(port, rangeKey, owner); return { port, mode: reused ? 'reuse' : 'claim' }; }
    const killed = probe.reclaimByCmdMark(o.reclaimCmdMark, o.reclaimCfg);
    if (killed > 0 && (await this._waitFree(port, owner, o.waitMs || 6000))) { this._register(port, rangeKey, owner); return { port, mode: 'reclaimed' }; }
    return null;
  }

  // skipFirst 只由 allocate() 传入（跳过锚点端口）；_claimSlotLocked 路径不传。
  async _allocFreeCore(rangeKey, range, owner, o) {
    const r = this._registry;
    const reserved = o.reservedPorts instanceof Set ? o.reservedPorts : null;
    const offset = (o.range ? 0 : r._anchorOffset(rangeKey)) + (o.skipFirst ? 1 : 0);
    // R6：联合避让。原只查 r._records（本方文件），router-daemon 与 guard 各写各的
    // 文件时会选中同一端口。改为查 _foreignPorts()（本方 + sibling 联合视图）。
    const joint = r._foreignPorts();
    for (let n = 0; n < range.count; n++) {
      const p = range.base + ((offset + n) % range.count);
      if (reserved && reserved.has(p)) continue;
      if (joint.has(p)) continue;
      if (await r.isTaken(p)) {
        if (o.reclaimCmdMark) {
          probe.reclaimByCmdMark(o.reclaimCmdMark, o.reclaimCfg);
          await new Promise((res) => setTimeout(res, o.waitMs || 2500));
        }
        if (await r.isTaken(p)) continue;
      }
      if (!(await probe.bindable(p))) continue;
      if (await this._confirmRegister(p, rangeKey, owner)) return { port: p, mode: 'allocated' };
    }
    return null;
  }

  // 游走公式、reservedPorts、joint.has、reclaimCmdMark、_confirmRegister 的唯一实现是
  // _allocFreeCore；此处只负责加解锁与 owner 缺省，不再自带一份会分叉的循环。
  // 返回形状与 _allocFreeCore 一致：{ port, mode }（调用方一律取 .port）。
  async allocate(rangeKey, owner, opts) {
    const r = this._registry;
    const range = r.rangeOf(rangeKey);
    if (!range) throw new Error('ports.allocate: 未知端口段 ' + rangeKey);
    const o = opts || {};
    const owner2 = owner || 'dynamic:' + rangeKey;
    await this._acquireAlloc();
    try {
      return await this._allocFreeCore(rangeKey, range, owner2, o);
    } finally {
      this._releaseAlloc();
    }
  }
}

module.exports = { PortAllocator };
