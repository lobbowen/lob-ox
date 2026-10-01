#!/usr/bin/env node
'use strict';

// 平台矩阵「单一事实源」：全仓**唯一**的平台事实校验点 —— `os/arch -> 标签` 曾散落 5 处（platform/os、
//   domains/relay/frpmgr.js、platform/distribution、guard/settings-view.js、domains/plugin/ops.js），
//   副本必然漂移且非本平台不被校验。M-b：npmTag / osTag / frpTag 四组合取值 + 不支持组合必须显式失败，不静默回落。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const matrix = require(path.join(ROOT, 'src', 'platform', 'contract', 'matrix.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

// -- M-b：行为正确（关键取值，跨平台语义）--
{
  // npm 命名（win-x64）与 frp 第三方命名（windows_amd64）**必须区分**（分叉会导致下载 404）。
  const expect = [
    { p: 'linux', a: 'x64', os: 'linux', npm: 'linux-x64', frp: 'linux_amd64', exe: false },
    { p: 'darwin', a: 'arm64', os: 'darwin', npm: 'darwin-arm64', frp: 'darwin_arm64', exe: false },
    { p: 'darwin', a: 'x64', os: 'darwin', npm: 'darwin-x64', frp: 'darwin_amd64', exe: false },
    { p: 'win32', a: 'x64', os: 'win', npm: 'win-x64', frp: 'windows_amd64', exe: true },
  ];
  check('M-b npmTag / osTag 四组合（osTag(win32) 必须是 win 而不是 win32）',
    expect.every((e) => matrix.npmTag(e.p, e.a) === e.npm && matrix.osTag(e.p) === e.os),
    expect.map((e) => e.p + '/' + e.a + '=' + matrix.npmTag(e.p, e.a) + '+' + matrix.osTag(e.p)).join(' '));
  check('M-b frpTag 四组合（frp 第三方命名 + exe 位）',
    expect.every((e) => { const f = matrix.frpTag(e.p, e.a); return !!f && f.tag === e.frp && f.exe === e.exe; }),
    expect.map((e) => e.p + '/' + e.a + '=' + JSON.stringify(matrix.frpTag(e.p, e.a))).join(' '));
  // supportsProcessGroup 站已回并 four-platform-behavior-matrix P-5（同一档位只留一处采样）。
  // 不支持组合：npmTag **抛错**（既有对外契约），不得静默回落。只判「抛了」，不匹配错误文案 ——
  //   文案改词即红属实现耦合。
  let err = null;
  try { matrix.npmTag('freebsd', 'x64'); } catch (e) { err = e.message; }
  check('M-b npmTag 对不支持平台抛错（不静默回落）', !!err, err || '(未抛)');
  check('M-b frpTag 对不支持平台返回 null（不猜）', matrix.frpTag('freebsd', 'x64') === null, 'null');
  // 真边界：未发布组合必须为假。**不用 SUPPORTED 校验 isSupported** —— 那是拿同一个源证明自己（自证）。
  check('M-b isSupported 边界：freebsd / linux-arm64 / win32-arm64 为假',
    matrix.isSupported('freebsd', 'x64') === false && matrix.isSupported('linux', 'arm64') === false
    && matrix.isSupported('win32', 'arm64') === false, 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
