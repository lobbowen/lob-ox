'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const RESYNC_WRITES = 64;

class Rotator {
  constructor(file, maxBytes) {
    this.file = file;
    this.maxBytes = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
    this._size = null;
    this._writes = 0;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch {}
    }
  }

  write(line) {
    if (!this.file) return;
    try {
      if (this._size === null) this._size = this._realSize();
      if (this._size >= this.maxBytes) {
        const backup = this.file + '.1';
        try {
          fs.unlinkSync(backup);
        } catch {}
        fs.renameSync(this.file, backup);
        this._size = 0;
      }
    } catch (e) {
      this._size = null;
      console.error('[logger] rotate failed:', e.message);
    }
    try {
      // mode 仅作用于文件首次创建：日志含启动令牌 URL，故收紧 0600（默认 0644 同机他用户可读）。
      fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
      if (this._size !== null) this._size += Buffer.byteLength(line) + 1;
      this._writes += 1;
      if (this._writes % Rotator.RESYNC_WRITES === 0) this._size = null;
    } catch (e) {
      this._size = null;
      console.error('[logger] write failed:', e.message);
    }
  }

  _realSize() {
    try {
      return fs.statSync(this.file).size;
    } catch { return 0; }
  }

  tail(n) {
    if (!this.file) return [];
    try {
      const all = fs.readFileSync(this.file, 'utf8');
      const lines = all.split('\n');
      return lines.slice(-Math.max(1, Number(n) || 100)).filter(Boolean);
    } catch {
      return [];
    }
  }

}
Rotator.RESYNC_WRITES = RESYNC_WRITES;

class LineBuffer {
  constructor(onLine) {
    this.onLine = onLine;
    this.rest = '';
  }

  push(chunk) {
    this.rest += chunk.toString();
    let idx;
    while ((idx = this.rest.indexOf('\n')) >= 0) {
      const line = this.rest.slice(0, idx);
      this.rest = this.rest.slice(idx + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  flush() {
    if (this.rest.trim()) this.onLine(this.rest);
    this.rest = '';
  }
}

function createLogger(opts) {
  const o = opts || {};
  const threshold = LEVELS[o.level] || LEVELS.info;
  const writer = new Rotator(o.file, o.maxBytes);
  const tag = o.process ? '[' + o.process + '] ' : '';
  const emit = (lv, msg) => {
    if ((LEVELS[lv] || 0) < threshold) return;
    const line = '[' + new Date().toISOString() + '] [' + lv.toUpperCase() + '] ' + tag + msg;
    writer.write(line);
    if (o.mirror !== false) console.error(line);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    writer,
  };
}

module.exports = { createLogger, Rotator, LineBuffer };
