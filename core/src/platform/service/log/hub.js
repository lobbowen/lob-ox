'use strict';

const path = require('node:path');
const Events = require('./events');
const sources = require('./sources');
const { visibleFrom, filteredFrom, exportFrom, metricsFrom, EventReader } = require('./core');
const { ctlCall, tailFile } = require('./tail');
const { loadWatermark, saveWatermark } = require('./watermark');

class EventHub {
  constructor(opts) {
    this.stateDir = opts.stateDir;
    this.aggBase = opts.aggBase || 'state';
    this.guardEvents = opts.guardEvents || null;
    this.guardLogFile = opts.guardLogFile || null;
    this.dshLogFile = opts.dshLogFile || null;
    this.upgradeLogFile = opts.upgradeLogFile || null;
    this.daemonLogs = opts.daemonLogs || {};
    this.ctlPorts = opts.ctlPorts || {};
    this._warnedKey = {};
    this._sources = sources.resolvedSources();
    this._localSource = (this._sources.find((s) => s.local) || { name: sources.LOCAL_SOURCE }).name;
    this._portFor = (which) => {
      const s = this._sources.find((x) => x.name === which);
      return this.ctlPorts[s ? s.key : which];
    };
    this.logger = opts.logger || null;
    this.aggDir = path.join(this.stateDir, 'events');
    this.aggFile = path.join(this.aggDir, this.aggBase + '.aggregated.events.log');
    this.watermarkFile = path.join(this.aggDir, this.aggBase + '.aggregated.watermark.json');
    this.writer = new Events(this.aggFile, (opts.eventsMaxBytes) || 5 * 1024 * 1024, { process: 'guard-hub' });
    this.watermark = {};
    this._generation = {};
    // R1：已 ingest 的 (generation:srcSeq) 集合，用于 daemon seq 回退后的重放判重。
    // 有界：每源最多记 5000 条，超出淘汰最旧（Map 保插入序）。
    this._ingested = new Map();
    this._ingestedCap = 5000;
    for (const s of this._sources) { this.watermark[s.name] = null; this._generation[s.name] = 0; }
    if (this.watermark[this._localSource] === undefined) this.watermark[this._localSource] = null;
    this._loadWatermark();
    if (this.watermark[this._localSource] == null && this.guardEvents) this.watermark[this._localSource] = this.guardEvents.seq;
    this._tickSeq = 0;
  }

  _log(level, msg) {
    try {
      const lg = this.logger;
      if (lg && typeof lg[level] === 'function') lg[level](msg);
    } catch {  }
  }

  _humaData(type, data) {
    if (data !== null && typeof data === 'object' && typeof data.message === 'string') return data;
    const msg = sources.humaneMsg(type, data);
    if (!msg) return data !== undefined ? data : null;
    return Object.assign({}, data || {}, { message: msg });
  }

  _loadWatermark() { loadWatermark(this.watermarkFile, this._sources, this.watermark); }

  _saveWatermark() { saveWatermark(this.aggDir, this.watermarkFile, this.watermark, this.logger); }

  _ingest(source, list) {
    let lastOkSeq = null;
    const gen = this._generation[source] || 0;
    for (const e of list) {
      if (!e || typeof e.seq !== 'number') continue;
      // R1：按 (generation, srcSeq) 判重。daemon 重启导致 seq 回退后，下一拍会
      // 重放一批已入过聚合的事件；此前它们以新聚合 seq 二次落盘，导致 /events 与
      // /logs/export 出现重复行、metrics 计数虚高。现在同代际同 srcSeq 直接跳过。
      const key = gen + ':' + e.seq;
      if (this._ingested.has(key)) continue;
      try {
        const rec = {
          ts: e.ts || undefined,
          type: e.type,
          data: this._humaData(e.type, e.data),
          source,
          srcSeq: e.seq,
          internal: sources.isInternalEvent(e.type),
        };
        if (e.producer) rec.producer = e.producer;
        this.writer.appendRaw(rec);
        if (this.writer._lastAppendOk === false) { this._log('warn', '[hub] ingest ' + source + ' seq=' + e.seq + ' 写盘失败，水位不推进'); break; }
        this._ingested.set(key, 1);
        // 有界：超出容量淘汰最旧一条。Map 保持插入序，第一条即最旧。
        if (this._ingested.size > this._ingestedCap) {
          const oldest = this._ingested.keys().next();
          if (!oldest.done) this._ingested.delete(oldest.value);
        }
        lastOkSeq = e.seq;
      } catch (e2) {
        this._log('warn', '[hub] ingest ' + source + ' seq=' + e.seq + ' failed: ' + ((e2 && e2.message) || e2));
        break;
      }
    }
    return lastOkSeq;
  }

  pushGuard(rec) {
    if (!rec || typeof rec.seq !== 'number') return;
    if (rec.source === 'guard-hub') return;
    const out = {
      ts: rec.ts || undefined,
      type: rec.type,
      data: this._humaData(rec.type, rec.data),
      source: this._localSource,
      srcSeq: rec.seq,
      internal: sources.isInternalEvent(rec.type),
    };
    if (rec.producer) out.producer = rec.producer;
    try {
      this.writer.appendRaw(out);
      if (this.writer._lastAppendOk === false) {
        this._log('warn', '[hub] pushGuard append failed (watermark held): ' + rec.seq);
        return;
      }
      this.watermark[this._localSource] = Math.max(this.watermark[this._localSource] || 0, rec.seq);
    } catch (e) {
      this._log('warn', '[hub] pushGuard append failed (watermark held): ' + ((e && e.message) || e));
    }
  }

  _syncGuard() {
    if (this.guardEvents && this.watermark[this._localSource] != null && this.guardEvents.seq > this.watermark[this._localSource]) {
      const list = this.guardEvents.tailSince(this.watermark[this._localSource]);
      const lastOk = list && list.length ? this._ingest(this._localSource, list) : null;
      if (lastOk != null) this.watermark[this._localSource] = Math.max(this.watermark[this._localSource], lastOk);
    }
  }

  // R1/D.8-P0-6：daemon seq 回退时不再把水位压到回退值。
  // 原实现回退时 this.watermark[which] = v.seq，下一拍用压低后的水位调
  // eventsTail，daemon 返回 seq > after 的全部事件，已入过聚合的被二次 ingest。
  // 聚合 writer 给每条重新分配聚合 seq，于是 /events 与 /logs/export 出现重复行，
  // metrics() 的 events 与 byType 计数虚高。
  // 修法：seq 回退从异常变成正常状态。水位改为「只增不减」，回退时递增代际
  // （generation），聚合层按 (generation, seq) 二元组判重。重复摄取是被允许的，
  // 去重是机械的——不再需要「压水位」这个危险操作。
  async _syncDaemon(which) {
    const port = this._portFor(which);
    if (!port) {
      if (!this._warnedKey[which]) {
        this._warnedKey[which] = true;
        this.logger && this.logger.warn && this.logger.warn('[hub] ' + which + ' ctlPort 未装配（检查该源的装配短键）——daemon 事件不入聚合');
      }
      return;
    }
    try {
      // 注意：eventsTail 传 limit（ctl/server.js 已支持），避免 watermark 重置
      // 那一拍把整个事件文件序列化进 HTTP 响应（D.6-P2-18）。
      const v = await ctlCall(port, 'eventsTail', [this.watermark[which] == null ? 0 : this.watermark[which], 2000], 2000);
      if (v && typeof v.seq === 'number') {
        if (this.watermark[which] == null) {
          this.watermark[which] = v.seq;
          return;
        }
        if (v.seq < this.watermark[which]) {
          // 回退：水位不降，只记一次告警。下一拍仍用原水位取，daemon 会返回
          // 一批重复事件，由 _ingest 的 (generation, seq) 判重消化。
          this._generation[which] = (this._generation[which] || 0) + 1;
          this.logger && this.logger.warn && this.logger.warn('[hub] ' + which + ' 事件 seq 回退(' + v.seq + '<' + this.watermark[which] + ')——水位不降，递增代际至 ' + this._generation[which] + '，按代际判重');
          return;
        }
        if (Array.isArray(v.events) && v.events.length) {
          const lastOk = this._ingest(which, v.events);
          this.watermark[which] = Math.max(this.watermark[which], lastOk != null ? Math.min(lastOk, v.seq) : this.watermark[which]);
        } else {
          this.watermark[which] = Math.max(this.watermark[which], v.seq);
        }
      }
    } catch (e) {
      this.logger && this.logger.debug && this.logger.debug('[hub] ' + which + ' eventsTail 不可用: ' + ((e && e.message) || e));
    }
  }

  async sync() {
    this._tickSeq += 1;
    try { this._syncGuard(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('[hub] guard sync: ' + ((e && e.message) || e)); }
    if (this._tickSeq % 6 === 1) {
      for (const s of this._sources) {
        if (s.local) continue;
        try { await this._syncDaemon(s.name); } catch {}
      }
    }
    this._saveWatermark();
  }

  read(after, limit) { return this.writer.readSince(after, limit); }

  get seq() { return this.writer.seq; }

  tailLog(stream, n) {
    const fixed = { dsh: this.dshLogFile, upgrade: this.upgradeLogFile };
    if (stream in fixed) return tailFile(fixed[stream], n);
    const s = this._sources.find((x) => x.name === stream || x.key === stream);
    if (s && s.local) return tailFile(this.guardLogFile, n);
    if (s) return tailFile((this.daemonLogs && this.daemonLogs[s.key]) || null, n);
    return tailFile(null, n);
  }

  window() { return this.writer.readAll(); }

  readVisible(after, limit) { return visibleFrom(this.window(), after, limit); }

  readFiltered(filter, after, limit) { return filteredFrom(this.window(), filter, after, limit); }

  exportLines(after, limit) { return exportFrom(this.window(), after, limit); }

  metrics() { return metricsFrom(this.window(), this.seq); }
}

module.exports = {
  EventHub, EventReader, tailFile,
  isInternalEvent: sources.isInternalEvent,
  ctlCall,
  registerSource: sources.registerSource,
  registerSources: sources.registerSources,
  setSources: sources.setSources,
  registerInternalType: sources.registerInternalType,
  setInternalTypes: sources.setInternalTypes,
};
