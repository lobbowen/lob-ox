'use strict';

// 令牌分类注册表（DSH-TOKEN-CONTRACT 契约1，唯一事实源）：令牌是一组而非一个概念，生成侧/我方职责/持久化位置各不同，数据化后由 pool/capture/persist 按 side/strategy 分派，避免在调用点复制判断（TK-3/TK-7）。
// 字段：side 为 dsh/dsh-derived/user/self；strategy 为我方职责；persistent 是否落盘；captured 可否被捕捉（用户配置类两者恒 false）；store 为权威存储；unitBacked 是否以 systemd 单元存在。
// DS-G4：平台不硬编码业务 kind 名，全部 kind 由 app/ 装配期经 registerKind/setKinds 注入；未注入时注册表为空，attach 携带未登记 kind 即拒绝（TK-3），生产路径始终先注入。

/** 契约1 全部 kind 的运行期注册表（键序即注入顺序，便于人工对照）。 */
const KINDS = {};
/** kind 登记顺序清单（与 KINDS 同步维护；仅本模块内部记账，不对外导出）。 */
const KIND_ORDER = [];

/** 登记或覆盖一个 kind（幂等；新增必须登记，TK-3）。返回是否登记成功。 */
function registerKind(name, def) {
  if (typeof name !== 'string' || !name) return false;
  if (!Object.prototype.hasOwnProperty.call(KINDS, name)) KIND_ORDER.push(name);
  KINDS[name] = def;
  return true;
}

/** 用给定映射整体替换已登记 kind（装配期幂等）。 */
function setKinds(map) {
  for (const k of Object.keys(KINDS)) delete KINDS[k];
  KIND_ORDER.length = 0;
  if (map && typeof map === 'object') {
    for (const k of Object.keys(map)) registerKind(k, map[k]);
  }
}

/** 幽灵键清单（契约1 末行）：不存在这些令牌，src/ 中必须零引用。
 *  显式登记废弃键名供门禁 TK-G7 以此表为权威自动覆盖；此处登记字面量不算引用，
 *  危害在于消费方把废弃键当真令牌使用，那正是 G7 要拦的。 */
const GHOST_KEYS = ['lanToken'];

/** kind 是否已登记；pool.attach 据此拒绝未登记 kind（TK-3）。 */
function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

/** 取 kind 定义（未登记返回 null，绝不抛，由调用方决定拒绝还是降级）。 */
function kindOf(kind) {
  return isKnownKind(kind) ? KINDS[kind] : null;
}

/** 是否由我方持久化。用户配置类恒 false（TK-7：不得写入令牌池文件）。 */
function isPersistent(kind) {
  const k = kindOf(kind);
  return !!(k && k.persistent);
}

/** 是否可由捕捉链路获得。只有 dsh 侧生成的两类为 true（TK-1/TK-3）。 */
function isCaptured(kind) {
  const k = kindOf(kind);
  return !!(k && k.captured);
}

/** 是否用户配置类（契约1 关键分野：不捕捉、不进 list()、不随 DSH 轮换）。 */
function isUserConfigKind(kind) {
  const k = kindOf(kind);
  return !!(k && k.side === 'user');
}

module.exports = {
  KINDS,
  GHOST_KEYS,
  registerKind,
  setKinds,
  isKnownKind,
  isPersistent,
  isCaptured,
  isUserConfigKind,
};
