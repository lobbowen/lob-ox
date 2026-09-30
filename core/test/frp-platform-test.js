#!/usr/bin/env node
'use strict';

// frp 平台映射测试：验证 frpPlatformTag 纯函数对三平台 x 双架构的官方产物命名正确性。
// 纯映射断言，不碰宿主，故在 test/manifest.js 标 L1（由 runner 随全链执行）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
//  结构改造：平台标签/镜像 URL 迁至 frp-install.js（frpmgr.js 已按副作用二分）。
const { frpPlatformTag, downloadUrls } = require(path.join(ROOT, 'src', 'domains', 'relay', 'frp-install'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const cases = [
  ['linux', 'x64', 'linux_amd64', false],
  ['linux', 'arm64', 'linux_arm64', false],
  ['darwin', 'x64', 'darwin_amd64', false],
  ['darwin', 'arm64', 'darwin_arm64', false],
  ['win32', 'x64', 'windows_amd64', true],
  ['win32', 'arm64', 'windows_arm64', true],
];
for (const [p, a, wantTag, wantExe] of cases) {
  const r = frpPlatformTag(p, a);
  check(p + '/' + a + ' -> ' + wantTag + (wantExe ? '(.exe)' : ''), !!(r && r.tag === wantTag && r.exe === wantExe), JSON.stringify(r));
}
check('freebsd 拒绝（无官方产物）', frpPlatformTag('freebsd', 'x64') === null, '');
check('ia32 拒绝（产品不支持 32 位）', frpPlatformTag('linux', 'ia32') === null, '');

// downloadUrls：三源镜像（ghfast/gh-proxy/官方直连）URL 主体必须**原样**携带平台资产名。
// 2026-10-12 瘦身（THIN-1-12）：旧判据把版本号（v0.61.1 / frp_0.61.1_…）写死，产品升版本即误红
//   （外部行为不变）→ 改用合成资产名验证原样透传；并补 urls.length 以免空数组让 every() 恒真。
const asset = 'frp_9.9.9_' + frpPlatformTag('linux', 'x64').tag + '.tar.gz';
const urls = downloadUrls(asset);
check('URL 原样携带平台资产名（三源）', urls.length === 3 && urls.every((u) => u.indexOf(asset) >= 0), urls.join(' | '));
check('官方直连为第三源（无镜像前缀，落在 fatedier/frp release 路径）',
  /^https:\/\/github\.com\/fatedier\/frp\/releases\/download\/v[^/]+\//.test(urls[2]) && urls[2].endsWith(asset), urls[2]);

const failed = results.filter((x) => !x);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);