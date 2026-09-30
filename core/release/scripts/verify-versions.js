'use strict';
// 版本自洽校验（**内核**）。
//
// 双仓隔离：壳版本校验（Cargo.toml / tauri.conf.json / Cargo.lock 三处互锁）
// 已迁回壳仓 scripts/verify-shell-versions.js —— 壳的版本属于壳自身，
// 不应由内核仓脚本管理。本文件只校验内核单源。
const mode = process.argv[2] || '--core';
const bad = [];
function coreCheck() {
  const pkg = require('../../package.json');
  // 版本规范：内核 = semver + 两档预览后缀（BETA.n / RC.n）——
  // 0.1.1-BETA.1 / 0.1.1-RC.1 / 0.1.1（无后缀=正式版）
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-(BETA|RC)\.[0-9]+)?$/.test(pkg.version || '')) {
    bad.push('package.json.version 非法: ' + pkg.version);
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
