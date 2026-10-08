'use strict';

/**
 * Outcome —— 全域统一的三态返回类型（根因 A 的修法）。
 *
 * 背景（实证）：本仓多处"存活/状态"判据把**未知**塌缩成布尔，导致三条 P0：
 *   1. pidlookup.isAlive() 把 probeAlive 的 'unknown' 塌成 false（判死）
 *   2. portable.isUnitActive 用 null 表示未知（6 处），调用方 `!== false` 把 null 当活跃
 *      ⇒ removeInstance 把"状态未知"报成"删除成功"
 *   3. 同上 ⇒ 升级后健康校验把"有人监听"当成"我们的实例在跑"
 *
 * 三态：ok / fail / unknown。unknown **既不是成功也不是失败**，调用方必须显式处置。
 *
 * 与既有模块同级：shared/guardian.js（限流原语）、shared/task-state.js（任务态映射）。
 * 这两处是本仓已验证的单源成功案例，本文件沿用同一范式。
 */

const OK = Object.freeze({ kind: 'ok' });
const UNKNOWN = Object.freeze({ kind: 'unknown' });

/** 失败：error 必须非空（否则调用方无从呈现原因） */
function fail(error) {
  return { kind: 'fail', error: String(error === undefined || error === null ? '' : error) };
}

function ofBool(b, error) {
  return b ? OK : fail(error || 'unknown failure');
}

/** 判据（唯一）：禁止用 !== false / === true / != null 之类的塌缩比较 */
const isOk = (o) => !!(o && o.kind === 'ok');
const isFail = (o) => !!(o && o.kind === 'fail');
const isUnknown = (o) => !(o && (o.kind === 'ok' || o.kind === 'fail'));

/**
 * 断言式判据：unknown 视为编程错误（用于"此处不可能未知"的调用点）。
 * 抛错优于静默：静默 unknown 正是本仓既往缺陷的成因。
 */
function expectKnown(o, where) {
  if (!isUnknown(o)) return o;
  throw new Error('Outcome: 未处置的 unknown（' + (where || '未标注调用点') + '）');
}

/** 降级：unknown → 指定 Outcome（用于"未知时按 X 处理"的显式策略） */
function unknownAs(o, fallback) {
  return isUnknown(o) ? fallback : o;
}

module.exports = {
  OK, UNKNOWN, fail, ofBool,
  isOk, isFail, isUnknown,
  expectKnown, unknownAs,
};
