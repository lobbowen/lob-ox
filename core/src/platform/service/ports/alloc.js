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
