'use strict';

// 发布通道选版（RELEASE-CHANNEL-CONTRACT 第3节）——唯一实现（纯，无 IO），禁止任何调用点再写第二套。
// 边界（契约第1节）：仅我们的包（@dsh-sup/ scope）走 rollback -> canary -> latest 语义；
// 第三方包不采纳他人 dist-tag（他人 tag 策略不受控），但同样 latest 优先、缺失/非法才回落 versions 最高（防杂 tag 当候选装到未验证版）。

const { semverCompare } = require('../../shared/version');

/** 「我们的」发布包 scope。同 scope 的 '@dsh-sup/shell-*' 亦由我们发布。 */
const OUR_RELEASE_SCOPE = '@dsh-sup/';

/** 该包名是否属于我们的发布通道；只有 true 时才允许 rollback/canary 语义。 */
function isOurReleasePackage(pkg) {
  return typeof pkg === 'string' && pkg.startsWith(OUR_RELEASE_SCOPE);
}

/** rollback 防降级下限（RC-7）：低于此版本的 rollback tag 一律忽略——持有发布令牌即可把任意旧版
 *  tag 成 rollback，无下限则一条 tag 写入即可把全员定向降级到已知漏洞旧版。
 *  下限 = 当前已发布安全基线，须随携带安全修复的发布同步上调（发布纪律，见 RELEASE-CHANNEL-CONTRACT.md RC-7）。 */
const ROLLBACK_FLOOR_VERSION = '0.1.5-BETA.10';

/** rollback 时效窗口（天）：目标版本发布时刻距今超过该天数即忽略。
 *  合法紧急回退的目标几乎总是刚发布不久的已知良好版本；翻存档的旧版被 tag 成
 *  rollback 本身就是异常信号。 */
const ROLLBACK_MAX_AGE_DAYS = 30;

/** rollback 防降级下限核验（RC-7）。true = 采纳该 rollback；false = 视为不存在，继续选版链。 */
function rollbackAllowed(version, meta, o) {
  const floor = typeof o.rollbackFloor === 'string' && o.rollbackFloor ? o.rollbackFloor : ROLLBACK_FLOOR_VERSION;
  if (semverCompare(version, floor) < 0) return false;
  const maxAgeDays = typeof o.rollbackMaxAgeDays === 'number' ? o.rollbackMaxAgeDays : ROLLBACK_MAX_AGE_DAYS;
  const t = meta && meta.time && typeof meta.time === 'object' ? meta.time[version] : null;
  const publishedAt = typeof t === 'string' ? Date.parse(t) : NaN;
  if (Number.isFinite(publishedAt)) {
    const now = typeof o.now === 'number' ? o.now : Date.now();
    if (now - publishedAt > maxAgeDays * 86400000) return false;
  }
  // time 缺失/不可解析（部分镜像剥掉 time 字段）：时效无从核验，交由版本下限兜底 ——
  // 此处 fail-closed 会挡住合法紧急回退；攻击面（任意旧版）已被下限封死。
  return true;
}

/** 我们的测试版形态（`-BETA.n`，发布为 tag beta）。 */
function isOurBetaRelease(v) { return /-BETA\./.test(String(v)); }

/** 在候选版本集合里取最高合法版本（semverCompare 判定）；空集返回 null。 */
function highestVersion(candidates, isValid) {
  let best = null;
  for (const v of candidates) {
    if (!isValid(v)) continue;
    if (best === null || semverCompare(v, best) > 0) best = v;
  }
  return best;
}

/** 选版算法（契约第3节冻结）——唯一实现：rollback（RC-2 显式信号，须过 RC-7 核验）-> canary（仅灰度名单机器，RC-4）
 *   -> latest（RC-1，绝不「取全量最高」：BETA 数字可能压过 RC）-> versions 最高合法（排除我们的 -BETA.，通道控制不交给镜像）
 *   -> null（RC-5 明确失败，绝不猜）。第三方包跳过前两步，按 latest -> versions 最高 -> null。
 *  @param meta { 'dist-tags', versions }；opts: isOurs/canary/isValid，rollbackFloor/rollbackMaxAgeDays/now 仅测试注入。 */
function pickReleaseVersion(meta, opts) {
  const o = opts || {};
  const isValid = typeof o.isValid === 'function' ? o.isValid : (v) => typeof v === 'string' && v.length > 0;
  const tags = (meta && meta['dist-tags']) || {};
  const versionKeys = (meta && meta.versions && typeof meta.versions === 'object') ? Object.keys(meta.versions) : [];
  // 只有「存在且合法」的 tag 才算数：脏 tag（如 'latest': 'beta'）一律忽略，走下一步。
  const validTag = (v) => (typeof v === 'string' && isValid(v) ? v : null);

  if (o.isOurs === true) {
    // 1) 回退最高优先级（RC-2）：独立 tag 是显式信号，不靠版本比较推断；
    //    但须通过防降级下限核验（RC-7），否则视为无 rollback 继续走链。
    const rollback = validTag(tags.rollback);
    if (rollback && rollbackAllowed(rollback, meta, o)) return rollback;
    // 2) 灰度：定向生效（RC-4），非名单机器即使 canary tag 存在也不受影响
    if (o.canary === true) {
      const canary = validTag(tags.canary);
      if (canary) return canary;
    }
    // 3) 正式：优先信 latest（RC-1），绝不「取全量最高」（BETA 的数字可能压过 RC）
    const latest = validTag(tags.latest);
    if (latest) return latest;
    // 4) 兼容兜底：latest 缺失/非法时才回落 versions 最高。兜底要恢复的事实是「最新正式版」
    //    而非「最新发布的任何东西」：镜像元数据丢 dist-tags 是常见合法缺失，放 -BETA. 进候选
    //    等于把通道控制交给镜像（一次不带 latest 的响应即可把全员静默升到测试版）。
    // 5) 只剩测试版或皆无 -> null（RC-5 明确失败，绝不猜）。
    return highestVersion(versionKeys.filter((v) => !isOurBetaRelease(v)), isValid);
  }

  // 第三方包（契约条 7）：不套 rollback/canary，但同样 latest 优先（他人杂 tag 不是我们的
  // 发布纪律）；latest 缺失/非法才回落 versions 最高；两路都无 -> null（RC-5）。
  const thirdLatest = validTag(tags.latest);
  if (thirdLatest) return thirdLatest;
  return highestVersion(versionKeys, isValid);
}

module.exports = {
  OUR_RELEASE_SCOPE,
  ROLLBACK_FLOOR_VERSION,
  ROLLBACK_MAX_AGE_DAYS,
  isOurReleasePackage,
  highestVersion,
  pickReleaseVersion,
};
