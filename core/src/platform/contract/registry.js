'use strict';

const fs = require('node:fs');

const SUPPORTED_SCHEMA = 3;

const REASON = {
  NO_FILE: 'contract-missing',
  BAD_JSON: 'contract-bad-json',
  BAD_SHAPE: 'contract-bad-shape',
  SCHEMA_NEWER: 'contract-schema-newer',
  EMPTY_CATALOG: 'contract-empty-catalog',
};

function normText(x) {
  return typeof x === 'string' ? x.trim() : '';
}

function shapeStrings(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = normText(x);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function shapeProbe(v) {
  if (!v || typeof v !== 'object' || typeof v.kind !== 'string') return null;
  return {
    kind: v.kind,
    pathTemplate: typeof v.pathTemplate === 'string' ? v.pathTemplate : null,
    timeoutMs: Number.isFinite(v.timeoutMs) && v.timeoutMs > 0
      ? Math.min(Math.max(v.timeoutMs, 1000), 20000) : 6000,
  };
}

function shapeMeasurements(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const origin = normText(x.origin);
    const checkedAt = Number(x.checkedAt);
    if (!origin || !Number.isFinite(checkedAt) || checkedAt <= 0) continue;
    out.push({
      origin,
      ok: x.ok === true,
      latencyMs: Number.isFinite(x.latencyMs) ? x.latencyMs : null,
      error: normText(x.error) || null,
      checkedAt,
    });
  }
  return out;
}

function read(file) {
  const empty = {
    ok: false, reason: REASON.NO_FILE, schema: null, writtenBy: null,
    catalog: [], probe: null, measurements: [], legacyChoice: null,
  };
  if (!file) return empty;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return empty; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return Object.assign({}, empty, { reason: REASON.BAD_JSON }); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return Object.assign({}, empty, { reason: REASON.BAD_SHAPE });
  }

  const schema = Number.isInteger(doc.schema) ? doc.schema : 1;
  const writtenBy = typeof doc.writtenBy === 'string' ? doc.writtenBy : null;

  if (schema > SUPPORTED_SCHEMA) {
    return Object.assign({}, empty, { reason: REASON.SCHEMA_NEWER, schema, writtenBy });
  }

  const catalog = shapeStrings(schema >= 2 ? doc.catalog : doc.origins);
  if (!catalog.length) {
    return Object.assign({}, empty, { reason: REASON.EMPTY_CATALOG, schema, writtenBy });
  }

  const measurements = schema >= 3
    ? shapeMeasurements(doc.measurements)
    : shapeMeasurements(doc.selected && doc.selected.origin ? [{
      origin: doc.selected.origin,
      ok: true,
      latencyMs: doc.selected.latencyMs,
      checkedAt: doc.selected.checkedAt,
    }] : null);

  const legacyMode = normText(doc.mode) === 'manual' ? 'manual' : null;
  const legacyManual = normText(doc.manualOrigin);
  const legacyChoice = schema < 3 && (legacyMode || legacyManual)
    ? { mode: legacyMode || 'auto', manualOrigin: legacyManual }
    : null;

  return {
    ok: true, reason: null, schema, writtenBy,
    catalog,
    probe: shapeProbe(doc.probe),
    measurements,
    legacyChoice,
  };
}

module.exports = { read, SUPPORTED_SCHEMA };
