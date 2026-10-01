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

  appendRaw(rec) {
    this.seq += 1;
    this._rotateIfNeeded();
    const out = Object.assign({}, rec || {});
    out.seq = this.seq;
    if (!out.ts) out.ts = new Date().toISOString();
    if (this.process && !out.producer) out.producer = { process: this.process };
    const line = JSON.stringify(out);
    let wrote = true;
    try {
      fs.appendFileSync(this.file, line + '\n');
      if (this._est !== null) this._est += Buffer.byteLength(line) + 1;
    } catch (e) {
      wrote = false;
      this._est = null;
      console.error('[events] append failed:', e.message);
    }
    if (this.seq - this._metaSavedSeq >= META_SAVE_EVERY || !wrote) this._saveMeta();
    this._lastAppendOk = wrote;
    if (this._hub && typeof this._hub.pushGuard === 'function') {
      try { this._hub.pushGuard(out); } catch (e2) { console.error('[events] hub push failed:', e2 && e2.message); }
    }
    return this.seq;
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

  tailSince(afterSeq) {
    afterSeq = Number(afterSeq) || 0;
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
    return out;
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
