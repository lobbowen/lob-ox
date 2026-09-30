'use strict';

// 共享读路径契约：窗口派生读只实现一次，EventHub 与 EventReader 共用，避免逻辑漂移。
// 纯函数 + 空对象适配器，无 IO。

const { isInternalEvent } = require('./sources');

function visibleFrom(win, after, limit) {
  const aft = Number(after) || 0;
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const out = [];
  for (const e of win) {
    if (e.seq <= aft) continue;
    if (e.internal === undefined ? isInternalEvent(e.type) : e.internal === true) continue;
    out.push(e);
  }
  return out.slice(-lim);
}

function filteredFrom(win, filter, after, limit) {
  const f = filter || {};
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const aft = Number(after) || 0;
  const out = [];
  for (const e of win) {
    if (e.seq <= aft) continue;
    if (f.source && e.source !== f.source) continue;
    if (f.type && !String(e.type || '').startsWith(f.type)) continue;
    out.push(e);
    if (out.length >= lim) break;
  }
  return out;
}

function exportFrom(win, after, limit) {
  const aft = Number(after) || 0;
  const lim = Math.min(Math.max(Number(limit) || 2000, 1), 20000);
  const lines = [];
  for (const e of win) {
    if (e.seq <= aft) continue;
    try { lines.push(JSON.stringify(e)); } catch {}
    if (lines.length >= lim) break;
  }
  return lines;
}

function metricsFrom(win, seq) {
  const total = win.length;
  const bySource = {};
  const byType = {};
  let lastTs = null;
  for (const e of win) {
    bySource[e.source || 'unknown'] = (bySource[e.source || 'unknown'] || 0) + 1;
    const t = String(e.type || 'unknown');
    byType[t] = (byType[t] || 0) + 1;
    if (!lastTs || (e.ts && e.ts > lastTs)) lastTs = e.ts;
  }
  const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, count]) => ({ type, count }));
  const now = Date.now();
  const lastAt = lastTs ? new Date(lastTs).getTime() : null;
  return { gseq: seq, events: total, bySource, topTypes, lastEventAt: lastTs, sinceLastMs: lastAt ? Math.max(0, now - lastAt) : null, ts: new Date().toISOString() };
}

// 降级读路径（空对象模式）：hub 不可用时把本地事件流适配成与 EventHub 相同的读接口。
class EventReader {
  constructor(events) { this.events = events; }
  get seq() { return this.events.seq; }
  window() { return this.events.readAll(); }
  read(after, limit) { return this.events.readSince(after, limit); }
  readVisible(after, limit) { return visibleFrom(this.window(), after, limit); }
  readFiltered(filter, after, limit) { return filteredFrom(this.window(), filter, after, limit); }
  tailLog() { return []; } // 降级模式无聚合日志（各 stream 返回空）
  exportLines(after, limit) { return exportFrom(this.window(), after, limit); }
  metrics() { return metricsFrom(this.window(), this.seq); }
  sync() { return Promise.resolve(); } // 无聚合流水位需同步
}

module.exports = { visibleFrom, filteredFrom, exportFrom, metricsFrom, EventReader };
