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
    for (const s of this._sources) this.watermark[s.name] = null;
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
    for (const e of list) {
      if (!e || typeof e.seq !== 'number') continue;
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
      const v = await ctlCall(port, 'eventsTail', [this.watermark[which] == null ? 0 : this.watermark[which]], 2000);
      if (v && typeof v.seq === 'number') {
        if (this.watermark[which] == null) {
          this.watermark[which] = v.seq;
          return;
        }
        if (v.seq < this.watermark[which]) {
          this.logger && this.logger.warn && this.logger.warn('[hub] ' + which + ' 事件 seq 回退(' + v.seq + '<' + this.watermark[which] + ')——按文件重置重建基线');
          this.watermark[which] = v.seq;
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
