'use strict';

// 分级日志 + 统一轮转：三类独立文件（守卫 / DSH 输出 / 升级输出）同一策略，
// 超过 maxBytes 改名 .1 保留一代，绝不无限增长。
// 同时镜像到 stderr：systemd user unit 下由 journald 收敛，journalctl 可查。

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 账本回读真实 stat 的行间隔（防多写者漂移长期累积）。 */
const RESYNC_WRITES = 64;

// 轮转写入器：逐行追加，超 maxBytes 改名 .1 保留一代，绝不无限增长。
// 尺寸记账取代「每行 statSync」：首写取一次真值、其后按已写字节累加；每 RESYNC_WRITES 行回读
// 真实 stat（同一路径可能被另一进程写，估算会漂移）；写盘/轮转异常即作废账本重新 stat。
class Rotator {
  constructor(file, maxBytes) {
    this.file = file;
    this.maxBytes = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
    this._size = null;  // null = 账本失效，下次写入前重新 stat
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
      // mode 仅作用于文件首次创建：日志含 dsh 输出的启动令牌 URL，故权限收紧为 0600，
      // 与 state.json 一致；默认 0644 时同机其他用户可读会话令牌。
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

  // 读取日志尾部至多 n 行（空行省略；文件不存在返回空数组）。
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

// 行缓冲：把任意切分的 chunk 还原成完整行再落盘（防半行日志）。
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

// 创建分级 logger。opts: { file, level='info', maxBytes=5MB, mirror=true }。
function createLogger(opts) {
  const o = opts || {};
  const threshold = LEVELS[o.level] || LEVELS.info;
  const writer = new Rotator(o.file, o.maxBytes);
  // 可选 process 标识日志归属进程（行级 producer）。
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
