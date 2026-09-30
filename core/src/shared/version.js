'use strict';

// semver 比较算法（纯函数，零依赖）。与 platform/service/version.js 无关，勿混：
// 本文件是比较算法；后者是守卫版本自报（读 package.json / __DSH_VERSION__）。

// 合法 semver（含 prerelease/build）。收紧：core 段禁止前导零，pre/build 标识符禁止
// 连续或首尾点（1.02.3、rc..1 均非法），防止脏版本号进入比较/安装链路。
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 简化 semver 比较：返回 >0 / 0 / <0。prerelease < release；build metadata 按规范忽略。 */
function semverCompare(a, b) {
  const parse = (v) => {
    const clean = String(v).split('+')[0];
    // 只在第一个连字符处切分：标识符本身可含连字符，split('-') 会丢掉 1.0.0-beta-2 的 -2。
    const dash = clean.indexOf('-');
    const core = dash === -1 ? clean : clean.slice(0, dash);
    const pre = dash === -1 ? '' : clean.slice(dash + 1);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((A.nums[i] || 0) !== (B.nums[i] || 0)) return (A.nums[i] || 0) - (B.nums[i] || 0);
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === '') return 1; // release > prerelease
  if (B.pre === '') return -1;
  const ap = A.pre.split('.');
  const bp = B.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (parseInt(x, 10) !== parseInt(y, 10)) return parseInt(x, 10) - parseInt(y, 10);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字段 < 字符串段（semver 规则）
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { semverCompare, VERSION_RE };
