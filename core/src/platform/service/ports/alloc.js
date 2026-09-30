'use strict';

// 端口分配与槽位仲裁（claimSlot / allocate）—— IO 编排层（探测/回收/登记）。
// 纯算法在 core.js；探测/回收在 probe.js。PortAllocator 经构造注入注册表（组合，非 mixin）。

const fs = require('node:fs');
const core = require('./core');
const probe = require('./probe');

/** 跨进程分配锁参数。注册表文件是多守卫共享的事实源（升级重叠期新旧守卫并存），
 *  内存布尔锁跨不了进程 —— 用 wx 独占创建同名 `.alloc.lock` 做自旋锁。 */
const XLOCK_TIMEOUT_MS = 3000;   // 拿不到锁的等待上界（超时后 fail-open 继续，见 _acquireXLock）
const XLOCK_STALE_MS = 15000;    // 持有者崩溃后的锁老化窗口（持锁临界区远短于此；超过即可接管）

class PortAllocator {
  constructor(registry) { this._registry = registry; this._xrel = null; }

  /** 确定性槽位仲裁（并发下单一互斥，防双分配）。 */
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
    while (r._allocLock) { await new Promise((res) => setTimeout(res, 10)); }
    r._allocLock = true;
    this._xrel = await this._acquireXLock();
    // 锁内对时（B2-5）：等锁期间他进程可能已登记新端口；不重载则陈旧快照会抢注
    //  「配置了端口但当前停止」的实例端口（TCP 探测看不见静默端口，注册表是唯一可见性）。
    r._syncFromDisk();
  }

  _releaseAlloc() {
    this._registry._allocLock = false;
    const rel = this._xrel; this._xrel = null;
    if (rel) { try { rel(); } catch { /* 锁文件已不在：无所谓 */ } }
  }

  /** 跨进程分配锁（best-effort）。返回释放函数；获取超时返回 null 并继续（fail-open 有界：
   *  登记后的「二次确认、被抢即撤销」复检是第二层防线，且 ports.json 读路径 reload 使外部
   *  分配可见 —— 宁可退化到复检层，也不让锁 IO 故障冻结分配）。 */
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
        return () => { if (unlocked) return; unlocked = true; try { fs.unlinkSync(f); } catch { /* 已被清理 */ } };
      } catch (e) {
        if (fh) { try { fs.closeSync(fh); } catch { /* noop */ } }
        if (e && e.code === 'EEXIST') {
          try {
            const st = fs.statSync(f);
            if (st.mtimeMs < Date.now() - XLOCK_STALE_MS) fs.unlinkSync(f); // 老化接管：持有者大概率已崩溃
          } catch { /* stat 失败：等下一轮或超时 */ }
          if (Date.now() < deadline) { await new Promise((res) => setTimeout(res, 25)); continue; }
          return null; // 超时：fail-open（见上）
        }
        return null; // ENOENT（目录消失）/EPERM（只读 FS）等：退化到复检层
      }
    }
  }

  /** 登记 + 有界复检（TOCTOU）：登记后端口若立刻被外部占用（bind 探测与登记间隙被抢），
   *  撤销登记并返回 false —— 宁可让调用方换下一个端口，也不留下必然失败的占用登记。
   *  self-listening 等「自己就在监听」的登记走 _register，不经本复检。 */
  async _confirmRegister(port, rangeKey, owner) {
    const r = this._registry;
    r._records.set(port, { port, role: rangeKey, owner, createdAt: Date.now() });
    r._save();
    for (let i = 0; i < 3; i++) {
      if (!(await probe.loopbackListening(port))) return true;
      if (probe.listeningPid(port) === process.pid) return true; // 自己人（本进程已监听）
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

  /** 显式冲突结构（绝不静默跳号）。 */
  _conflict(owner, rangeKey, reason, port) {
    const cap = this._registry.capacity()[core.SEGMENT_POOL[rangeKey] || 'managed'] || null;
    return Object.assign({ owner, segment: rangeKey, conflict: true, reason, error: 'port-pool-exhausted', capacity: cap }, port ? { port } : {});
  }

  /** 写入一条新登记（已存在则不动）。 */
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

  /** 尝试认领单个端口（自听/复用/新占/回收）；不可则 null。 */
  async _tryClaim(port, owner, rangeKey, o) {
    if (!port) return null;
    const r = this._registry;
    const rec = r._records.get(port);
    if (probe.listeningPid(port) === process.pid) { this._register(port, rangeKey, owner); return { port, mode: 'self-listening' }; }
    if (rec && rec.owner !== owner) return null;
    const reused = !!(rec && rec.owner === owner);
    if (!(await r.isTaken(port, owner))) { this._register(port, rangeKey, owner); return { port, mode: reused ? 'reuse' : 'claim' }; }
    const killed = probe.reclaimByCmdMark(o.reclaimCmdMark, o.reclaimCfg);
    if (killed > 0 && (await this._waitFree(port, owner, o.waitMs || 6000))) { this._register(port, rangeKey, owner); return { port, mode: 'reclaimed' }; }
    return null;
  }

  /** 池内最小空闲分配（不获取锁；调用方已持 _allocLock）。 */
  async _allocFreeCore(rangeKey, range, owner, o) {
    const r = this._registry;
    const offset = o.range ? 0 : r._anchorOffset(rangeKey);
    for (let n = 0; n < range.count; n++) {
      const p = range.base + ((offset + n) % range.count);
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
      // 复检失败=间隙被抢：撤销登记已在 _confirmRegister 内完成，继续扫下一个端口
    }
    return null;
  }

  /** 段内最小空闲分配并登记；池满返回 null。 */
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
