'use strict';
// 版本自洽校验（**内核**）。
//
// 双仓隔离：壳版本校验（Cargo.toml / tauri.conf.json / Cargo.lock 三处互锁）在壳仓
// scripts/verify-shell-versions.js —— 壳的版本属于壳自身。本文件只校验内核单源。
const mode = process.argv[2] || '--core';
const bad = [];
function coreCheck() {
  const pkg = require('../../package.json');
  // 版本规范：内核 = **合法 SemVer**（三段数值 + 可选预发布/构建后缀）——
  //   0.1.1（正式）/ 0.1.1-BETA.1 / 0.1.1-RC.1 / 0.1.6-BETA.21-test1 均合法。
  // 校验**委托产品内权威校验器**（src/shared/version.js:8 的 VERSION_RE），本文件不自带实现：
  //   内联更窄的正则（只认 -BETA.n / -RC.n）会与产品校验器分裂，拒掉合法版本，而本门禁在 CI 里真跑。
  //   委托后判定口径与产品同一份：**非法 SemVer（1.2 / abc / 1.02.3 / 1.0.0-）依旧判红**，
  //   放宽的只是「合法的预发布后缀形态」，不是「什么都收」。
  // 若 src/shared/version.js 缺失/不可 require，require 直接抛出 ⇒ 本脚本非零退出（判红而非静默放行）。
  const { VERSION_RE } = require('../../src/shared/version.js');
  if (!VERSION_RE.test(pkg.version || '')) {
    bad.push('package.json.version 非法（须为合法 SemVer，与 src/shared/version.js 同一判定）: ' + pkg.version);
  }
  if (!bad.length) console.log('内核版本 OK: ' + pkg.version + '（package.json 单源）');
}
if (mode === '--core') {
  coreCheck();
} else {
  console.error('未知模式: ' + mode + '（本仓只支持 --core；壳版本校验见壳仓 scripts/verify-shell-versions.js）');
  process.exit(2);
}
if (bad.length) { console.error('版本校验失败:\n- ' + bad.join('\n- ')); process.exit(1); }
