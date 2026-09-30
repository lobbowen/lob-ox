'use strict';

// EventHub：守卫事件聚合枢纽 — 各进程事件文件单写者，本类只读聚合后转写唯一聚合事件流，对外 /events 读它。
// gseq 即聚合流 seq：全局单调、meta 续号、跨守卫重启连续（UI after 游标稳定）；
// daemon 增量经 ctl eventsTail 拉取（复用既有 ctl 通道），失败降级跳过。
// 不变量：聚合流文件与水位只由 EventHub 写；职责分层见 sources/core/tail/watermark 各文件。

const path = require('node:path');
const Events = require('./events');
const sources = require('./sources');
const { visibleFrom, filteredFrom, exportFrom, metricsFrom, EventReader } = require('./core');
const { ctlCall, tailFile } = require('./tail');
const { loadWatermark, saveWatermark } = require('./watermark');

class EventHub {
  // opts: stateDir 守卫状态目录（聚合流/水位落此）；guardEvents 守卫 Events 实例（源之一）；
  // guardLogFile/dshLogFile/upgradeLogFile 守卫侧运行日志（/logs/tail 用）；
  // daemonLogs/ctlPorts 按装配短键索引；logger 可选。
  constructor(opts) {
    this.stateDir = opts.stateDir;
    // 聚合流/水位按 aggBase 派生唯一名：同一 stateDir 下多守卫（测试 TMP）共写同一
    // aggregated 文件会让 hub 自己制造多写者、seq 互踩。
    this.aggBase = opts.aggBase || 'state';
    this.guardEvents = opts.guardEvents || null;
    this.guardLogFile = opts.guardLogFile || null;
    this.dshLogFile = opts.dshLogFile || null;
    this.upgradeLogFile = opts.upgradeLogFile || null;
    // 装配键契约：外部用装配短键；聚合源名由注册接口注入（registerSource）。
    this.daemonLogs = opts.daemonLogs || {};
    this.ctlPorts = opts.ctlPorts || {};
    this._warnedKey = {};
    this._sources = sources.resolvedSources();
    // 本进程本地推源名（默认 LOCAL_SOURCE；由注册方以 local:true 声明）。
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
    // 水位默认 null=未初始化：启用时不回溯历史存量，只聚合启用后增量。
    this.watermark = {};
    for (const s of this._sources) this.watermark[s.name] = null;
    if (this.watermark[this._localSource] === undefined) this.watermark[this._localSource] = null;
    this._loadWatermark();
    // 本地源基线：启用即当前 seq（不回溯历史）。
    if (this.watermark[this._localSource] == null && this.guardEvents) this.watermark[this._localSource] = this.guardEvents.seq;
    this._tickSeq = 0;
  }

  // 内部告警出口：经可选 logger，绝不抛（失败路径上的最后一环）。
  _log(level, msg) {
    try {
      const lg = this.logger;
      if (lg && typeof lg[level] === 'function') lg[level](msg);
    } catch { /* 告警出口本身绝不抛 */ }
  }

  // 事件人性化：浅拷贝源 data 并注入可读 message，不改源事件对象。
  _humaData(type, data) {
    if (data !== null && typeof data === 'object' && typeof data.message === 'string') return data;
    const msg = sources.humaneMsg(type, data);
    if (!msg) return data !== undefined ? data : null;
    return Object.assign({}, data || {}, { message: msg });
  }

  _loadWatermark() { loadWatermark(this.watermarkFile, this._sources, this.watermark); }

  _saveWatermark() { saveWatermark(this.aggDir, this.watermarkFile, this.watermark, this.logger); }

  // 转写事件到聚合流，返回最后成功写入的源 seq；写失败不推进水位（RC5.2 契约）。
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
        this.writer.appendRaw(rec); // 聚合流 seq/ts 由 appendRaw 注入
        if (this.writer._lastAppendOk === false) { this._log('warn', '[hub] ingest ' + source + ' seq=' + e.seq + ' 写盘失败，水位不推进'); break; }
        lastOkSeq = e.seq;
      } catch (e2) {
        // appendRaw 正常不抛，此分支防御性保留：不推进水位，sync 重试补齐。
        this._log('warn', '[hub] ingest ' + source + ' seq=' + e.seq + ' failed: ' + ((e2 && e2.message) || e2));
        break;
      }
    }
    return lastOkSeq;
  }

  // 推模式：守卫 Events.append 已同步调此，守卫事件零延迟入聚合流。
  pushGuard(rec) {
    if (!rec || typeof rec.seq !== 'number') return;
    // hub 来源标记：防御聚合流文件被误配为守卫事件文件时的递归（RC5.3 纵深防御之一）
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
        // 写盘失败：水位不动，_syncGuard 后续拍补转写（事件不丢）。
        this._log('warn', '[hub] pushGuard append failed (watermark held): ' + rec.seq);
        return;
      }
      this.watermark[this._localSource] = Math.max(this.watermark[this._localSource] || 0, rec.seq);
    } catch (e) {
      this._log('warn', '[hub] pushGuard append failed (watermark held): ' + ((e && e.message) || e));
    }
  }

  // 兼容守卫扫文件增量入口：推模式下守卫事件已同步入流，本方法只补转写缺失增量并保水位。
  _syncGuard() {
    if (this.guardEvents && this.watermark[this._localSource] != null && this.guardEvents.seq > this.watermark[this._localSource]) {
      const list = this.guardEvents.tailSince(this.watermark[this._localSource]);
      const lastOk = list && list.length ? this._ingest(this._localSource, list) : null;
      if (lastOk != null) this.watermark[this._localSource] = Math.max(this.watermark[this._localSource], lastOk);
    }
  }

  // 经 ctl 拉 daemon 事件增量并转写；失败降级（daemon 未监督/未起）。
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
          // 首拉：只建基线（daemon 存量历史不回溯转写）
          this.watermark[which] = v.seq;
          return;
        }
        if (v.seq < this.watermark[which]) {
          // daemon 事件文件被清/重置（seq 回退）：重建基线不 ingest 存量。
          this.logger && this.logger.warn && this.logger.warn('[hub] ' + which + ' 事件 seq 回退(' + v.seq + '<' + this.watermark[which] + ')——按文件重置重建基线');
          this.watermark[which] = v.seq;
          return;
        }
        if (Array.isArray(v.events) && v.events.length) {
          const lastOk = this._ingest(which, v.events);
          // 水位推进到最后成功转写的源 seq 与源文件 seq 的较小者，写失败不越界
          this.watermark[which] = Math.max(this.watermark[which], lastOk != null ? Math.min(lastOk, v.seq) : this.watermark[which]);
        } else {
          this.watermark[which] = Math.max(this.watermark[which], v.seq);
        }
      }
    } catch (e) {
      // daemon 未起/未受监督属运行态而非装配错误：debug 级防刷，守卫 /events 仍含守卫事件。
      this.logger && this.logger.debug && this.logger.debug('[hub] ' + which + ' eventsTail 不可用: ' + ((e && e.message) || e));
    }
  }

  // 心跳每拍调用：把各源增量聚合进聚合流。
  async sync() {
    this._tickSeq += 1;
    try { this._syncGuard(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('[hub] guard sync: ' + ((e && e.message) || e)); }
    // 远端源（ctl 拉取）每 ~6 拍拉一次（约 30s；与监督节流一致，避免每拍 ctl）
    if (this._tickSeq % 6 === 1) {
      for (const s of this._sources) {
        if (s.local) continue;
        try { await this._syncDaemon(s.name); } catch {}
      }
    }
    this._saveWatermark();
  }

  // 对外增量读：seq > after（gseq 即聚合流 seq）。
  read(after, limit) { return this.writer.readSince(after, limit); }

  get seq() { return this.writer.seq; }

  // /logs/tail：dsh/upgrade 为预设流；守卫与业务流按注册源装配短键解析。
  tailLog(stream, n) {
    const fixed = { dsh: this.dshLogFile, upgrade: this.upgradeLogFile };
    if (stream in fixed) return tailFile(fixed[stream], n);
    const s = this._sources.find((x) => x.name === stream || x.key === stream);
    if (s && s.local) return tailFile(this.guardLogFile, n);
    if (s) return tailFile((this.daemonLogs && this.daemonLogs[s.key]) || null, n);
    return tailFile(null, n);
  }

  // 读聚合流全窗（供检索/导出/metrics；readAll 全量，无 readSince 500 上限）。
  window() { return this.writer.readAll(); }

  // 用户时间线读：seq > after 且非 internal 的最近 limit 条业务事件。
  readVisible(after, limit) { return visibleFrom(this.window(), after, limit); }

  // 事件检索：filter { type?: 前缀, source? } 匹配事件（limit 上限 2000）。
  readFiltered(filter, after, limit) { return filteredFrom(this.window(), filter, after, limit); }

  // 审计导出：把聚合流原文行导出为 JSONL 文本。
  exportLines(after, limit) { return exportFrom(this.window(), after, limit); }

  // 遥测派生（/metrics）：事件流上的只读投影。
  metrics() { return metricsFrom(this.window(), this.seq); }
}

module.exports = {
  EventHub, EventReader, tailFile,
  isInternalEvent: sources.isInternalEvent,
  ctlCall,
  // DS-G4 装配注入接口（app/assembly/log-sources.js 消费）
  registerSource: sources.registerSource,
  registerSources: sources.registerSources,
  setSources: sources.setSources,
  registerInternalType: sources.registerInternalType,
  setInternalTypes: sources.setInternalTypes,
};
