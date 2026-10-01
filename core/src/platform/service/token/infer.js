'use strict';

let _infer = { byId: null, unitPrefix: [], unitKind: null, fileKind: null };

function configureKindInference(table) {
  const t = (table && typeof table === 'object') ? table : {};
  _infer = {
    byId: (t.byId && typeof t.byId === 'object') ? t.byId : null,
    unitPrefix: Array.isArray(t.unitPrefix) ? t.unitPrefix.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') : [],
    unitKind: (typeof t.unitKind === 'string' && t.unitKind) ? t.unitKind : null,
    fileKind: (typeof t.fileKind === 'string' && t.fileKind) ? t.fileKind : null,
  };
}

function kindInference() {
  return {
    byId: _infer.byId ? Object.assign({}, _infer.byId) : null,
    unitPrefix: _infer.unitPrefix.map((p) => p.slice()),
    unitKind: _infer.unitKind,
    fileKind: _infer.fileKind,
  };
}

function inferKind(id, src) {
  if (_infer.byId && _infer.byId[id]) return _infer.byId[id];
  const unit = src && src.unit ? String(src.unit) : '';
  if (unit) {
    for (const p of _infer.unitPrefix) { if (unit.startsWith(p[0])) return p[1]; }
    if (_infer.unitKind) return _infer.unitKind;
  }
  if (src && src.file && _infer.fileKind) return _infer.fileKind;
  return null;
}

module.exports = { configureKindInference, kindInference, inferKind };
