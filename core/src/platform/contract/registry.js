'use strict';

// 镜像契约读取器（壳写、内核只读）：契约文件 <产品状态根>/supervisor/registry.json。
// 只判定文档形状，不判定镜像源是否可用 —— 后者只在 distribution/registry-ref.js 定义一次，
// 两处重复判定会出现「契约收下、消费判非法」的两套答案。
// schema 3：catalog/probe/measurements 在契约；mode/manualOrigin 与选择结果在内核自持的
//   registry-choice.json，旧字段仅作 legacyChoice 供一次性迁移，不再从契约取选择字段。
// 不变量：契约缺失/损坏返回 { ok:false, reason }，调用方回退兜底，绝不启动失败。

const fs = require('node:fs');

const SUPPORTED_SCHEMA = 3;

/** 契约不可用时的理由码（供事件与诊断）。 */
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

/** 源列表的形状清洗：非空字符串并去重（保序）；是否算合法镜像由消费侧 registry-ref 判定。 */
function shapeStrings(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = normText(x);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 探测规格形状校验；形状不对返回 null，调用方回退 /-/ping。timeoutMs 夹在 1s–20s
 *  （两侧超时不同会把「介于两者之间」的源判成一侧可达一侧不可达）。 */
function shapeProbe(v) {
  if (!v || typeof v !== 'object' || typeof v.kind !== 'string') return null;
  return {
    kind: v.kind,
    pathTemplate: typeof v.pathTemplate === 'string' ? v.pathTemplate : null,
    timeoutMs: Number.isFinite(v.timeoutMs) && v.timeoutMs > 0
      ? Math.min(Math.max(v.timeoutMs, 1000), 20000) : 6000,
  };
}

/** 测速证据：壳本轮对目录里各源的实际结论。只校验形状（origin 为字符串、checkedAt 为正数），
 *  可达/延迟/拒因原样带上，由选源侧决定信多少。 */
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

/** 读取镜像契约；契约不可用时返回 ok:false 与 reason，绝不抛错。 */
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

  // 契约比本内核新时明确拒绝，不猜格式。
  if (schema > SUPPORTED_SCHEMA) {
    return Object.assign({}, empty, { reason: REASON.SCHEMA_NEWER, schema, writtenBy });
  }

  // v2/v3 用 catalog，v1 用 origins，两者都接受。
  const catalog = shapeStrings(schema >= 2 ? doc.catalog : doc.origins);
  if (!catalog.length) {
    return Object.assign({}, empty, { reason: REASON.EMPTY_CATALOG, schema, writtenBy });
  }

  // v3 测速证据在契约里；v2 只有单个 selected，折算成同形状交给选源侧。
  const measurements = schema >= 3
    ? shapeMeasurements(doc.measurements)
    : shapeMeasurements(doc.selected && doc.selected.origin ? [{
      origin: doc.selected.origin,
      ok: true,
      latencyMs: doc.selected.latencyMs,
      checkedAt: doc.selected.checkedAt,
    }] : null);

  // v2 及更早的选择字段只作一次性迁移输入（legacyChoice），不参与常态选源。
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
