'use strict';
// 必须复用 src/shared/version.js:3 的 VERSION_RE；内联更窄正则会拒掉合法 SemVer。
const mode = process.argv[2] || '--core';
const bad = [];
function coreCheck() {
  const pkg = require('../../package.json');
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
