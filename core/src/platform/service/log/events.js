'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../util/fs');

const META_SAVE_EVERY = 32;

class Events {
  constructor(file, maxBytes, opts) {
    this.file = file;
    this.maxBytes = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
    this.process = (opts && opts.process) || null;
    this.rotatedSeq = null;
    this.seq = 0;
    this.metaFile = file ? file + '.meta.json' : null;
    this._est = null;
    this._metaSavedSeq = -1;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch {}
      this._loadMeta();
      const fileMax = this._fileMaxSeq();
      if (fileMax > this.seq) this.seq = fileMax;
      this._metaSavedSeq = this.seq;
    }
  }

  _loadMeta() {
    if (!this.metaFile) return false;
    try {
      const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      if (typeof m !== 'object' || !m) return false;
      if (typeof m.seq === 'number' && m.seq >= 0) this.seq = m.seq;
      if (typeof m.rotatedSeq === 'number' && m.rotatedSeq >= 0) this.rotatedSeq = m.rotatedSeq;
      return true;
    } catch { return false; }
  }

  _saveMeta() {
    if (!this.metaFile) return;
    try {
      writeAtomic(this.metaFile, JSON.stringify({ seq: this.seq, rotatedSeq: this.rotatedSeq }), { mode: 0o600 });
      this._metaSavedSeq = this.seq;
    } catch (e) {
      console.error('[events] meta save failed:', e.message);
    }
  }

  _maxSeq() {
    let max = 0;
    for (const f of [this.file + '.1', this.file]) {
      try {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
          } catch {}
        }
      } catch {}
    }
    return max;
  }

  _fileMaxSeq() {
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (!size) return this._maxSeq();
        const from = Math.max(0, size - 8192);
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        const lines = buf.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].trim()) continue;
          try {
            const e = JSON.parse(lines[i]);
            if (typeof e.seq === 'number') return e.seq;
          } catch {  }
        }
      } finally { fs.closeSync(fd); }
    } catch {  }
    return this._maxSeq();
  }

  _rotateIfNeeded() {
    try {
      if (this._est === null) {
        try { this._est = fs.statSync(this.file).size; }
        catch { this._est = 0; return; }
      }
      if (this._est < this.maxBytes) return;
      let real = 0;
      try { real = fs.statSync(this.file).size; } catch { this._est = 0; return; }
      this._est = real;
      if (real < this.maxBytes) return;
      const backup = this.file + '.1';
      fs.renameSync(this.file, backup);
      this.rotatedSeq = this.seq;
      this._est = 0;
      this._saveMeta();
    } catch (e) {
      this._est = null;
      console.error('[events] rotate failed:', e.message);
    }
  }

  attachHub(hub) {
    this._hub = hub;
  }

  append(type, data) {
    const rec = { type, data: data ?? null };
    return this.appendRaw(rec);
  }

  // R1/D.8-P0-5：seq 分配与落盘结果必须绑定。
  // 原实现先 this.seq += 1 再 appendFileSync，失败时只 console.error 不回退，
  // 且 !wrote 时 _saveMeta() 把那个没落盘的 seq 写进 meta.json。
  // 重启后 hub.js 用 meta 里虚高的值初始化 watermark，_syncGuard 的
  // guardEvents.seq > watermark 恒 false，失败点之后的所有事件永久不入聚合流，
  // 直到 seq 自然追平（每天几条日志则数天不可见）。
  // 不变式：this.seq 恒等于「已确认落盘的最大序号」。失败时序号不前进，
  // 下一条记录重试同一序号——seq 空洞只存在于内存，不存在于 meta。
  appendRaw(rec) {
    const out = Object.assign({}, rec || {});
    if (!out.ts) out.ts = new Date().toISOString();
    if (this.process && !out.producer) out.producer = { process: this.process };
    // 序号必须先落到 out 上、再序列化：写盘的是序列化后的字符串，若先 stringify
    // 后赋 seq，落盘记录里就没有 seq 字段，而 readSince/tailSince 一律按
    // e.seq > after 过滤 —— 结果是全部磁盘事件恒读不出来（增量流恒空）。
    // 不变式不变：this.seq 仍只在写入成功后前进，失败时下一条重试同一序号。
    this._rotateIfNeeded();
    const candidate = this.seq + 1;
    out.seq = candidate;
    const line = JSON.stringify(out);
    let wrote = true;
    try {
      fs.appendFileSync(this.file, line + '\n');
      if (this._est !== null) this._est += Buffer.byteLength(line) + 1;
    } catch (e) {
      wrote = false;
      this._est = null;
      console.error('[events] append failed（seq 不前进，下一条重试同一序号）:', e.message);
    }
    if (wrote) this.seq = candidate;
    // meta 只在成功时写。失败时序号留在内存供重试，绝不把未落盘的 seq 写进 meta。
    if (wrote && this.seq - this._metaSavedSeq >= META_SAVE_EVERY) this._saveMeta();
    this._lastAppendOk = wrote;
    if (wrote && this._hub && typeof this._hub.pushGuard === 'function') {
      try { this._hub.pushGuard(out); } catch (e2) { console.error('[events] hub push failed:', e2 && e2.message); }
    }
    return wrote ? this.seq : null;
  }

  readSince(after = 0, limit = 50) {
    after = Number(after) || 0;
    limit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const out = [];
    const scan = (file, needed) => {
      if (!needed) return;
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            if (e.seq > after) out.push(e);
          } catch {}
        }
      } catch {}
    };
    scan(this.file + '.1', this.rotatedSeq !== null && after < this.rotatedSeq);
    scan(this.file, true);
    return out.slice(-limit);
  }

  // D.6-P2-18：limit 必填。此前无上限，watermark 重置那一拍（hub.js 的首次与
  // seq 回退两条路径）会让 ctl 的 eventsTail 把整个事件文件含 .1 备份读进内存并
  // JSON.stringify 进 HTTP 响应，同步阻塞该 ctl server 的事件循环数百毫秒，
  // 期间所有 ctl 方法（含健康检查）无响应。与 readSince 的钳制口径对齐。
  tailSince(afterSeq, limit) {
    afterSeq = Number(afterSeq) || 0;
    const cap = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const out = [];
    const scan = (file, needed) => {
      if (!needed) return;
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            if (e.seq > afterSeq) out.push(e);
          } catch {}
        }
      } catch {}
    };
    scan(this.file + '.1', this.rotatedSeq !== null && afterSeq < this.rotatedSeq);
    scan(this.file, true);
    return out.slice(-cap);
  }

  readAll() {
    const out = [];
    const scan = (file, needed) => {
      if (!needed) return;
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const l of lines) {
          if (!l.trim()) continue;
          try { out.push(JSON.parse(l)); } catch {}
        }
      } catch {}
    };
    scan(this.file + '.1', this.rotatedSeq !== null);
    scan(this.file, true);
    return out;
  }
}

module.exports = Events;
