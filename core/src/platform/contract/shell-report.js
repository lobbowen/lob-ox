'use strict';

// 桌面壳环境上报的读取口（壳写、内核读）：<产品状态根>/supervisor/shell-report.json（schema 1），
// 与 ./runtime.js 的 runtime.json 同目录。那份是启动契约（内核拿它 spawn），本份是观测报告，
// 只给人和判据读、不参与 spawn，两者形状互不迁移；读不到就标 never-written，不补不重试。
// 三态纪律：ok/writable/reachable 允许 true|false|null，null 表示壳也判不出，不得折成 false
//   ——「没报」与「报了不通过」是两件事。机密边界：壳来的自由文本在此过一次 ../util/redact。

const fs = require('node:fs');
const path = require('node:path');
const stateRoot = require('../service/state-root');
const { maskProxyServer, maskProxySecrets } = require('../util/redact');

/** 与壳写入侧握手的 schema：不等即整份作废，字段形状变了不能靠猜。 */
const SUPPORTED_SCHEMA = 1;

/** 报告文件名（落点与启动契约同目录，全仓只在这里拼一次）。 */
const FILE_NAME = 'shell-report.json';

/** 单份报告的字节上限：它由另一个进程写，读侧不能假设自己看到的一定是小文件。 */
const MAX_BYTES = 256 * 1024;

/** 明细行数上限：超限只截断留痕，不撑大快照与 HTTP 响应。 */
const MAX_ROWS = 64;

function file() {
  return path.join(stateRoot.supervisorDir(), FILE_NAME);
}

const str = (v) => (typeof v === 'string' && v.trim() ? maskProxySecrets(v.trim()) : null);
const raw = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** 三态布尔：只认真假，其余一律 null。 */
const tri = (v) => (v === true || v === false ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);

function nodeView(n) {
  const o = n && typeof n === 'object' ? n : null;
  if (!o) return null;
  return { path: str(o.path), binDir: str(o.binDir), version: raw(o.version), min: raw(o.min), ok: tri(o.ok) };
}

function npmView(n) {
  const o = n && typeof n === 'object' ? n : null;
  if (!o) return null;
  // args 与 program 成对：壳可以把 npm 表达成「node + 包内 npm-cli.js」，只念 path 会读错被探测物。
  return { path: str(o.path), args: list(o.args).map(String), version: raw(o.version), ok: tri(o.ok) };
}

function prefixView(n) {
  const o = n && typeof n === 'object' ? n : null;
  if (!o) return null;
  return { dir: str(o.dir), writable: tri(o.writable), why: str(o.why) };
}

function registryView(n) {
  const o = n && typeof n === 'object' ? n : null;
  if (!o) return null;
  const rows = list(o.probes).slice(0, MAX_ROWS).map((p) => ({
    url: p && typeof p === 'object' ? maskProxyServer(raw(p.url)) : null,
    ok: p && typeof p === 'object' ? tri(p.ok) : null,
    latencyMs: p && typeof p === 'object' ? num(p.latencyMs) : null,
  }));
  return { best: maskProxyServer(raw(o.best)), latencyMs: num(o.latencyMs), probes: rows, probesTotal: list(o.probes).length };
}

/** 壳的探测记录原样规整（probe/source/target/ms/ok/note 与壳侧 Record::json 同键）。 */
function recordsView(recs) {
  const all = list(recs);
  const rows = all.slice(0, MAX_ROWS).map((r) => {
    const o = r && typeof r === 'object' ? r : {};
    return { probe: raw(o.probe) || 'unknown', source: str(o.source) || '', target: str(o.target) || '',
      ms: num(o.ms), ok: tri(o.ok), note: str(o.note) || '' };
  });
  return { rows, truncated: all.length > MAX_ROWS ? all.length - MAX_ROWS : 0 };
}

/** 报告主体：至少一个维度非空或有一条明细才算有内容，否则返回 null（不拿空对象冒充实况）。 */
function bodyOf(j) {
  const recs = recordsView(j.records);
  const body = {
    writtenBy: raw(j.writtenBy),
    schema: num(j.schema),
    node: nodeView(j.node),
    npm: npmView(j.npm),
    prefix: prefixView(j.prefix),
    registry: registryView(j.registry),
    records: recs.rows,
    droppedRecords: recs.truncated,
  };
  const seen = [body.node, body.npm, body.prefix, body.registry].some((x) => !!x) || body.records.length > 0;
  return seen ? body : null;
}

/** 摊平为一层：读侧再套一层 data 只会让界面写出 data.data。 */
function envelope(p, at, ageMs, reason, body) {
  return Object.assign({ available: reason === 'ok', path: p, at, ageMs, reason }, body || {
    writtenBy: null, schema: null, node: null, npm: null, prefix: null, registry: null, records: [], droppedRecords: 0,
  });
}

/** 读壳投放的环境报告，永不抛错；读不出与没报过分档上报。
 *  @param {{now?:Function}} [o] 注入时钟，判定年龄用
 *  @returns {{available:boolean,path:string,at:number|null,ageMs:number|null,
 *             reason:'ok'|'never-written'|'unreadable-or-schema-mismatch',
 *             schema:number|null,writtenBy:string|null,node:object|null,npm:object|null,
 *             prefix:object|null,registry:object|null,records:object[],droppedRecords:number}} */
function read(o) {
  const now = (o && typeof o.now === 'function') ? o.now : Date.now;
  const p = file();
  let text;
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_BYTES) return envelope(p, null, null, 'unreadable-or-schema-mismatch', null);
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return envelope(p, null, null, 'never-written', null);
    return envelope(p, null, null, 'unreadable-or-schema-mismatch', null);
  }
  let j;
  try { j = JSON.parse(text); } catch { return envelope(p, null, null, 'unreadable-or-schema-mismatch', null); }
  if (!j || typeof j !== 'object' || Array.isArray(j) || num(j.schema) !== SUPPORTED_SCHEMA) {
    return envelope(p, null, null, 'unreadable-or-schema-mismatch', null);
  }
  const at = num(j.at);
  if (at === null) return envelope(p, null, null, 'unreadable-or-schema-mismatch', null);
  const ageMs = Math.max(0, now() - at);
  const body = bodyOf(j);
  if (!body) return envelope(p, at, null, 'unreadable-or-schema-mismatch', null);
  return envelope(p, at, ageMs, 'ok', body);
}

module.exports = { SUPPORTED_SCHEMA, FILE_NAME, MAX_BYTES, MAX_ROWS, file, read };
