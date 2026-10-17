#!/usr/bin/env node
'use strict';

// 版本 / 运行时契约自检（生产脚本，非测试）：
//   1. 版本号必须是合法 SemVer（判定函数 = src/shared/version.js 的 VERSION_RE，单源）。
//   2. package.json#engines.node 必须与 shared/shared-constants.json#runtime.minNode 推导值逐字相同。
//   3. changelog.json 的**最新条目版本段**必须等于 package.json#version。
//
// 存在的理由：minNode 有三个消费方（env-catalog.js 的环境卡、node.rs 的壳侧判定、
// npm 的 engines），npm 的 engines 只 warn 不强制 ⇒ 口径一旦漂移，用户会在低于下限的
// Node 上装得上却拉不起内核。这里把它变成发布路径上的启动期断言：口径漂移在 bump 时即红。
// 第 3 条的存在理由：0.0.23 与 0.0.24 连续两个版本发布时忘了写更新日志，而用户在面板点
// 「更新日志」只看得到旧内容。这条断言让「忘写 changelog」在 bump 时即红，而不是等用户发现。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const { VERSION_RE } = require(path.join(ROOT, 'src', 'shared', 'version.js'));
const SHARED = require(path.join(ROOT, 'src', 'shared', 'shared-constants.js'));

// 单源 → npm engines 表达式的唯一推导式（minNode 形如 'v22.12.0'）
function enginesFromMinNode(minNode) {
  return '>=' + String(minNode).replace(/^v/i, '');
}

// changelog.json 是数组，按书写顺序倒序取最新条目（最新版本写在最前）。
// 判据用「版本段相等」而非「存在该版本」——后者在补写历史条目后会失效。
function latestChangelogVersion() {
  const p = path.join(ROOT, 'src', 'shared', 'changelog.json');
  if (!fs.existsSync(p)) return { ok: false, why: 'changelog.json 不存在：' + p };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { ok: false, why: 'changelog.json 不是合法 JSON：' + (e && e.message) }; }
  if (!Array.isArray(arr) || !arr.length) return { ok: false, why: 'changelog.json 为空数组' };
  let latest = null;
  for (const e of arr) {
    if (e && typeof e.version === 'string' && VERSION_RE.test(e.version)) {
      if (latest === null || semverGreater(e.version, latest)) latest = e.version;
    }
  }
  if (latest === null) return { ok: false, why: 'changelog.json 无任何合法 version 条目' };
  return { ok: true, version: latest };
}

// 版本比较复用单源（不内联第二份 semver 解析）
function semverGreater(a, b) {
  try {
    const { semverCompare } = require(path.join(ROOT, 'src', 'shared', 'version.js'));
    return semverCompare(a, b) > 0;
  } catch { return String(a) > String(b); }
}

function coreCheck() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let bad = 0;

  if (!VERSION_RE.test(String(pkg.version || ''))) {
    console.error('  FAIL package.json#version 不是合法 SemVer: ' + pkg.version);
    bad++;
  }

  const want = enginesFromMinNode(SHARED.runtime.minNode);
  const got = pkg.engines && pkg.engines.node;
  if (got !== want) {
    console.error('  FAIL engines.node 口径漂移：package.json=' + JSON.stringify(got)
      + '，按单源 runtime.minNode(' + SHARED.runtime.minNode + ') 推导应为 ' + JSON.stringify(want));
    bad++;
  } else {
    console.log('  OK   engines.node = ' + got + '（= 单源 runtime.minNode ' + SHARED.runtime.minNode + '）');
  }

  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const lockNode = lock.packages && lock.packages[''] && lock.packages[''].engines
      && lock.packages[''].engines.node;
    if (lockNode !== want) {
      console.error('  FAIL package-lock.json#packages[""].engines.node = ' + JSON.stringify(lockNode)
        + '，应为 ' + JSON.stringify(want) + '（lock 与 package.json 必须同口径）');
      bad++;
    }
  }

  // 更新日志必须跟着版本走：用户点「更新日志」只看 changelog.json，
  // 最新条目落后于 package.json#version 就是「版本发了但内容缺」。
  const cl = latestChangelogVersion();
  if (!cl.ok) {
    console.error('  FAIL 更新日志不可读：' + cl.why);
    bad++;
  } else if (cl.version !== String(pkg.version)) {
    console.error('  FAIL 更新日志落后于版本号：changelog.json 最新条目 = ' + cl.version
      + '，package.json#version = ' + pkg.version
      + '（发布前必须补该版本的更新日志，否则用户在面板上看不到本次变更）');
    bad++;
  } else {
    console.log('  OK   更新日志最新条目 = ' + cl.version + '（= package.json#version）');
  }

  return bad;
}

let bad = 0;
switch (process.argv[2] || '--core') {
  case '--core': bad = coreCheck(); break;
  default:
    console.error('用法: verify-versions.js --core');
    process.exit(2);
}
process.exit(bad ? 1 : 0);
