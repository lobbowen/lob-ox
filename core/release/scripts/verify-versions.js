#!/usr/bin/env node
'use strict';

// 版本 / 运行时契约自检（生产脚本，非测试）：
//   1. 版本号必须是合法 SemVer（判定函数 = src/shared/version.js 的 VERSION_RE，单源）。
//   2. package.json#engines.node 必须与 shared/shared-constants.json#runtime.minNode 推导值逐字相同。
//
// 存在的理由：minNode 有三个消费方（env-catalog.js 的环境卡、node.rs 的壳侧判定、
// npm 的 engines），npm 的 engines 只 warn 不强制 ⇒ 口径一旦漂移，用户会在低于下限的
// Node 上装得上却拉不起内核。这里把它变成发布路径上的启动期断言：口径漂移在 bump 时即红。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const { VERSION_RE } = require(path.join(ROOT, 'src', 'shared', 'version.js'));
const SHARED = require(path.join(ROOT, 'src', 'shared', 'shared-constants.js'));

// 单源 → npm engines 表达式的唯一推导式（minNode 形如 'v22.12.0'）
function enginesFromMinNode(minNode) {
  return '>=' + String(minNode).replace(/^v/i, '');
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
