'use strict';

// 源形态到 kind 推断（纯函数，DS-G4 反转法）：平台不硬编码业务 kind 名或单元前缀，
// 规则由 app/ 装配期经 configureKindInference 注入；未注入时无任何映射，未登记的源不会被
// 猜成某个域 kind（TK-3）。字段：byId=id 直接命中；unitPrefix=[前缀,kind] 列表；
// unitKind=任意非空单元兜底；fileKind=恢复文件源的 kind。

let _infer = { byId: null, unitPrefix: [], unitKind: null, fileKind: null };

/** 注入“源形态到 kind”推断表（整体替换，幂等）。 */
function configureKindInference(table) {
  const t = (table && typeof table === 'object') ? table : {};
  _infer = {
    byId: (t.byId && typeof t.byId === 'object') ? t.byId : null,
    unitPrefix: Array.isArray(t.unitPrefix) ? t.unitPrefix.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') : [],
    unitKind: (typeof t.unitKind === 'string' && t.unitKind) ? t.unitKind : null,
    fileKind: (typeof t.fileKind === 'string' && t.fileKind) ? t.fileKind : null,
  };
}

/** 当前推断表快照（副本；供装配自检/测试）。 */
function kindInference() {
  return {
    byId: _infer.byId ? Object.assign({}, _infer.byId) : null,
    unitPrefix: _infer.unitPrefix.map((p) => p.slice()),
    unitKind: _infer.unitKind,
    fileKind: _infer.fileKind,
  };
}

/** 由“源形态”反推 kind；显式 kind 永远优先（本函数仅在缺少 kind 时调用）。 */
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
