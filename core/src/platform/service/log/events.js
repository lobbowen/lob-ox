'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../util/fs');

// 事件日志：append-only JSONL，行 { seq, ts, type, data }；seq 全局单调，供 /events?after= 增量拉取；按大小轮转保留一代 .1，跨轮转增量读由 readSince 双代合并。
// seq/rotatedSeq 持久化到 <file>.meta.json（原子写），重启从 meta 续号；meta 缺失/损坏回退扫描双代文件续号（不丢新事件）。
// 续号取 max(meta.seq, 文件尾实际最大 seq)——meta 每 META_SAVE_EVERY 才落一次盘、只看 meta 会重号；append-only 且单调 => 末行即最大，末行不可解析回退全扫描。轮转时 meta 立即落盘（rotatedSeq 不即时持久化则 .1 事件重启后不可见）；尺寸按已写字节估算、越阈真 stat 复核（多写者漂移不误轮转）。
const META_SAVE_EVERY = 32;

class Events {
  constructor(file, maxBytes, opts) {
    this.file = file;
    this.maxBytes = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
    // 行级 producer.process：由事件文件所属进程注入，跨进程聚合/审计据此区分来源。
    this.process = (opts && opts.process) || null;
    this.rotatedSeq = null; // 轮转水位：.1 中最后一条事件的 seq（readSince 按 after < rotatedSeq 决定是否扫旧代）
    this.seq = 0;
    this.metaFile = file ? file + '.meta.json' : null;
    this._est = null;      // 已估字节；null = 需重新 stat
    this._metaSavedSeq = -1;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch {}
      this._loadMeta();
      // 无论 meta 是否可用，都必须与文件实际内容对齐（meta 可能被节流落在后面）。
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

  // 持久化 meta（原子写 tmp + rename）。失败仅记日志，不影响事件主流程。
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
    // 回退路径（meta 缺失/损坏）必须同时扫描 .1：若刚轮转过，当前文件为空而 .1 含全部
    // 旧 seq，只扫当前文件会让 seq 从 0 重计，与 .1 重号，readSince 合并即重复/乱序。
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

  // 文件实际最大 seq —— 只读尾部（append-only + seq 单调，末行即最大）。
  // 末行不可解析（截断起点落在行中 / 崩溃残留半行）时从后往前找首条完整记录；
  // 整段都解析不出（文件为空/刚轮转走）才回退 _maxSeq() 全扫描，含 .1 防与旧代重号。
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
          } catch { /* 半行：继续向前找 */ }
        }
      } finally { fs.closeSync(fd); }
    } catch { /* 文件不存在等：回退全扫描 */ }
    return this._maxSeq();
  }

  _rotateIfNeeded() {
    try {
      if (this._est === null) {
        try { this._est = fs.statSync(this.file).size; }
        catch { this._est = 0; return; } // 文件尚不存在
      }
      if (this._est < this.maxBytes) return;
      // 估算越阈：真 stat 复核后才改名 —— 账本漂移（另一进程写同一文件）不得触发误轮转。
      let real = 0;
      try { real = fs.statSync(this.file).size; } catch { this._est = 0; return; }
      this._est = real;
      if (real < this.maxBytes) return;
      const backup = this.file + '.1';
      // rename 到已存在路径即原子覆盖，勿先 unlink：unlink+rename 两步间崩溃会丢一代事件。
      fs.renameSync(this.file, backup);
      this.rotatedSeq = this.seq;
      this._est = 0;
      this._saveMeta(); // 轮转必须即时持久化 rotatedSeq（跨重启 .1 仍可见）
    } catch (e) {
      this._est = null; // 轮转失败：账本作废，下次重新 stat
      console.error('[events] rotate failed:', e.message);
    }
  }

  // 守卫把本事件流接入 EventHub（attachHub）后，append 同步转写聚合流，守卫事件零延迟可见。
  attachHub(hub) {
    this._hub = hub;
  }

  append(type, data) {
    const rec = { type, data: data ?? null };
    return this.appendRaw(rec);
  }

  // 追加原始记录（EventHub 聚合转写用）：注入 seq/ts/producer，保留其余字段。
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
      this._est = null; // 写盘结果未知：账本作废，下一事件重新 stat
      console.error('[events] append failed:', e.message);
    }
    // meta 节流落盘；写盘失败时立即落一次（保住已成功的 seq 事实）。
    if (this.seq - this._metaSavedSeq >= META_SAVE_EVERY || !wrote) this._saveMeta();
    // 写盘失败可观测，供 EventHub 水位不推进、下轮补齐（RC5.2 契约）；不可恒吞错误致水位虚进。
    this._lastAppendOk = wrote;
    // 已接 EventHub 则同步推入聚合流（同进程单写，无多写者）。
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
    // 先旧后新：.1 中事件 seq <= rotatedSeq
    scan(this.file + '.1', this.rotatedSeq !== null && after < this.rotatedSeq);
    scan(this.file, true);
    return out.slice(-limit);
  }

  // 增量尾部：返回 seq > afterSeq 的事件（双代合并），守卫 EventHub / daemon ctl 拉取用。
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

  // 全量读：双代合并、无 500 上限，审计/检索/metrics/过滤型时间线的数据源。
  // readSince 的 limit 钳只适合增量分页，不可当全量视图。
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
