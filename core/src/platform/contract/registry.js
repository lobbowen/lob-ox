'use strict';

// 镜像契约读取器（壳写、内核只读）：契约文件 <产品状态根>/supervisor/registry.json；所有权在壳。
// 本文件只判定「这份文档的形状对不对」，不判定「某个镜像源能不能用」—— 后者只在
// distribution/registry-ref.js 定义一次。读取器里再写一把 scheme 正则就会出现「契约收下、消费判非法」
// 的两套答案：schema2 时代带 path 的华为云/腾讯云源正是在这里被收下、又在探测处判死。
// schema 演进：v1 mode/origins/manualOrigin；v2 增 catalog/selected/probe；v3 按「谁写哪份」拆开 ——
//   catalog/probe/measurements 留在契约（壳有），mode/manualOrigin 与选择结果搬到内核自持的
//   registry-choice.json（内核有）。v2 里那几个字段仍解析，但只作为 legacyChoice 交给
//   registry-config 做一次性迁移，之后选择字段不再从契约取。
// 不变量：契约缺失/损坏时返回 { ok:false, reason }，调用方回退最小兜底，绝不启动失败。

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

/** 源列表的**形状**清洗：只要求是非空字符串并去重（保序）。是否算「一个合法镜像」由消费侧的
 *  registry-ref 判定 —— 读取侧不猜，非法条目才能带着原样到达面板的逐源结论里。 */
function shapeStrings(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = normText(x);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 探测规格的形状校验：kind 是字符串才认，timeoutMs 有界（两侧超时不同会把「介于两者之间」的源
 *  判成一侧可达一侧不可达）。形状不对就当没有，调用方回退 /-/ping。 */
function shapeProbe(v) {
  if (!v || typeof v !== 'object' || typeof v.kind !== 'string') return null;
  return {
    kind: v.kind,
    pathTemplate: typeof v.pathTemplate === 'string' ? v.pathTemplate : null,
    timeoutMs: Number.isFinite(v.timeoutMs) && v.timeoutMs > 0
      ? Math.min(Math.max(v.timeoutMs, 1000), 20000) : 6000,
  };
}

/** v3 的测速证据：壳本轮对目录里各源的实际结论。只校验形状（origin 是字符串、checkedAt 是正数），
 *  可达/延迟/拒因原样带上，由选源侧决定信多少（过期不用、缺源自己补测）。 */
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

  // v2/v3 用 catalog；v1 只有 origins。两者都接受以实现平滑升级。
  const catalog = shapeStrings(schema >= 2 ? doc.catalog : doc.origins);
  if (!catalog.length) {
    return Object.assign({}, empty, { reason: REASON.EMPTY_CATALOG, schema, writtenBy });
  }

  // v3 的测速证据在契约里；v2 只有一个 selected 结论，折算成同样形状交给选源侧（形状适配属于
  // schema 演进，留在这里；「能不能采用」的判定不在这里）。
  const measurements = schema >= 3
    ? shapeMeasurements(doc.measurements)
    : shapeMeasurements(doc.selected && doc.selected.origin ? [{
      origin: doc.selected.origin,
      ok: true,
      latencyMs: doc.selected.latencyMs,
      checkedAt: doc.selected.checkedAt,
    }] : null);

  // v2 及更早：内核曾经把选择字段写进这份契约，壳也曾经读过 mode=manual 来避免覆盖。升级后这些
  // 字段一律只作一次性迁移输入，不再参与常态选源。
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
