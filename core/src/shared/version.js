'use strict';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function semverCompare(a, b) {
  const parse = (v) => {
    // 剥掉 `v` 前缀：minNode 读自 shared-constants.json（形如 v22.12.0），
    // 而 node -v 输出与 runtime.json 记录不带前缀（10.24.1）。此前两者用同一个
    // 解析器比较时，v22.12.0 的首段是 v22，parseInt 得 NaN 后被 `|| 0` 静默归零，
    // 于是 22 被读成 0，判定「v22.12.0 < 10.24.1」成立 —— 版本门禁反而放行低版本。
    // Rust 侧 core.rs::semver_cmp 同一处缺陷已同步修复；两边必须一致，否则判据分叉。
    const clean = String(v).split('+')[0].trim().replace(/^[vV]/, '');
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
  if (A.pre === '') return 1;
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
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { semverCompare, VERSION_RE };
