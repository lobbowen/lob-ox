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

  /**
   * Lease I1：把"检查"与"置位"放在**同一个同步块**内。
   *
   * 修前：`while (r._allocLock) { await sleep(10); } r._allocLock = true;`
   * —— 检查与置位之间隔着 await，两个并发 claimSlot 可同时观察到 false 并都置 true（真 TOCTOU）。
   * 现在用 Lease.acquireSync 做同步 test-and-set；未取得则由调用方退避重试。
   */
  async _acquireAlloc() {
    const r = this._registry;
    let waited = 0;
    for (;;) {
      if (lease.acquireSync(r, '_allocLock')) break;
      await new Promise((res) => setTimeout(res, 10));
      waited += 10;
      // 有界退避：避免某处忘记释放导致永久挂起（fail-open 有界，与既有 XLOCK_TIMEOUT_MS 同一取舍）。
      if (waited >= XLOCK_TIMEOUT_MS) { r._allocLock = true; break; }
    }
    this._xrel = await this._acquireXLock();
    r._syncFromDisk();
  }

  _releaseAlloc() {
    this._registry._allocLock = false;
    const rel = this._xrel; this._xrel = null;
    if (rel) { try { rel(); } catch {  } }
  }

  // 跨进程分配锁 best-effort：获取超时返回 null 并继续（fail-open 有界，登记后复检是第二道防线）。
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
          // Lease I3：回收前必须校验持锁者是否存活。
          // 修前是 statSync 后直接 unlinkSync（无归属校验）⇒ 本进程可能删掉**另一进程持有的活锁**，
          // 随后多个进程同时建锁并全部进入临界区。
          let recyclable = false;
          try { recyclable = lease.lockRecyclable(f, XLOCK_STALE_MS); } catch { recyclable = false; }
          if (recyclable) { try { fs.unlinkSync(f); } catch {  } }
          if (Date.now() < deadline) { await new Promise((res) => setTimeout(res, 25)); continue; }
          return null;
        }
        return null;
      }
    }
  }

  async _confirmRegister(port, rangeKey, owner) {
    const r = this._registry;
    r._records.set(port, { port, role: rangeKey, owner, createdAt: Date.now() });
    r._save();
    for (let i = 0; i < 3; i++) {
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
    // 审计 RL-4：若 preferred 端口已被其它账本占用，则视为不可复用（不抢 router 的端口）。
    if (reserved && reserved.has(Number(port))) return null;
    const rec = r._records.get(port);
    if (probe.listeningPid(port) === process.pid) { this._register(port, rangeKey, owner); return { port, mode: 'self-listening' }; }
    if (rec && rec.owner !== owner) return null;
    const reused = !!(rec && rec.owner === owner);
    if (!(await r.isTaken(port, owner))) { this._register(port, rangeKey, owner); return { port, mode: reused ? 'reuse' : 'claim' }; }
    const killed = probe.reclaimByCmdMark(o.reclaimCmdMark, o.reclaimCfg);
    if (killed > 0 && (await this._waitFree(port, owner, o.waitMs || 6000))) { this._register(port, rangeKey, owner); return { port, mode: 'reclaimed' }; }
    return null;
  }

  async _allocFreeCore(rangeKey, range, owner, o) {
    const r = this._registry;
    const reserved = o.reservedPorts instanceof Set ? o.reservedPorts : null;
    const offset = o.range ? 0 : r._anchorOffset(rangeKey);
    for (let n = 0; n < range.count; n++) {
      const p = range.base + ((offset + n) % range.count);
      // 审计 RL-4：跨账本防撞。reservedPorts 为其它账本（如 router）已占用的端口集合，
      // 命中则跳过该候选，绝不把 router 的端口分给本域（router caller 不传此集合，行为不变）。
      if (reserved && reserved.has(p)) continue;
      if (r._records.has(p)) continue;
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

  async allocate(rangeKey, owner, opts) {
    const r = this._registry;
    const range = r.rangeOf(rangeKey);
    if (!range) throw new Error('ports.allocate: 未知端口段 ' + rangeKey);
    const o = opts || {};
    const start = (o.range ? 0 : r._anchorOffset(rangeKey)) + (o.skipFirst ? 1 : 0);
    await this._acquireAlloc();
    try {
      for (let n = 0; n < range.count; n++) {
        const p = range.base + ((start + n) % range.count);
        if (r._records.has(p)) continue;
        if (await r.isTaken(p)) continue;
        if (!(await probe.bindable(p))) continue;
        const owner2 = owner || 'dynamic:' + rangeKey;
        if (await this._confirmRegister(p, rangeKey, owner2)) return p;
        continue;
      }
      return null;
    } finally {
      this._releaseAlloc();
    }
  }
}

module.exports = { PortAllocator };
