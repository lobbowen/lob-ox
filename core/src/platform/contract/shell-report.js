'use strict';

// 壳上报读取口：<状态根>/supervisor/shell-report.json（schema 1）；三态 ok/writable/reachable 的 null 表示壳也判不出，不得折成 false。

const fs = require('node:fs');
const path = require('node:path');
const stateRoot = require('../service/state-root');
const { maskProxyServer, maskProxySecrets } = require('../util/redact');

const SUPPORTED_SCHEMA = 1;

const FILE_NAME = 'shell-report.json';

const MAX_BYTES = 256 * 1024;

const MAX_ROWS = 64;

function file() {
  return path.join(stateRoot.supervisorDir(), FILE_NAME);
}

const str = (v) => (typeof v === 'string' && v.trim() ? maskProxySecrets(v.trim()) : null);
const raw = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
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

function recordsView(recs) {
  const all = list(recs);
  const rows = all.slice(0, MAX_ROWS).map((r) => {
    const o = r && typeof r === 'object' ? r : {};
    return { probe: raw(o.probe) || 'unknown', source: str(o.source) || '', target: str(o.target) || '',
      ms: num(o.ms), ok: tri(o.ok), note: str(o.note) || '' };
  });
  return { rows, truncated: all.length > MAX_ROWS ? all.length - MAX_ROWS : 0 };
}

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

function envelope(p, at, ageMs, reason, body) {
  return Object.assign({ available: reason === 'ok', path: p, at, ageMs, reason }, body || {
    writtenBy: null, schema: null, node: null, npm: null, prefix: null, registry: null, records: [], droppedRecords: 0,
  });
}

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
