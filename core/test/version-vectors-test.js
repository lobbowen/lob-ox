#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 版本语义**共享测试向量**回归：壳（Rust）与内核（JS）各自实现版本校验/比较，跨语言无法共享
// 代码，故共享**行为规格**本仓 shared/version-vectors.json（实测分歧：`1.0.0+`、`1.0.0+!!!`、
// `1.0.0+あ` 壳判合法、内核旧实现判非法）。两仓不互相读源码——跨仓一致性属契约产物问题。
// 本测试：V1 逐条断言内核实现（VERSION_RE / semverCompare）符合向量。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const dist = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
// VERSION_RE 与 semverCompare 由 dist 导出（内核侧的**唯一**实现）。
const { VERSION_RE, semverCompare } = dist;

const VEC = path.join(ROOT, 'shared', 'version-vectors.json');
const raw = fs.readFileSync(VEC, 'utf8');
const doc = JSON.parse(raw);

// -- V1 逐条断言 --
console.log('== V1 版本向量（内核实现）==');
{
  for (const c of doc.versionValidation) {
    const got = VERSION_RE.test(c.input);
    check('V1 合法性 ' + JSON.stringify(c.input) + ' → ' + c.valid + (c.why ? '（' + c.why + '）' : ''),
      got === c.valid, 'got=' + got);
  }
  for (const c of doc.compare) {
    const got = Math.sign(semverCompare(c.a, c.b));
    check('V1 比较 ' + c.a + ' vs ' + c.b + ' → ' + c.expected + (c.why ? '（' + c.why + '）' : ''),
      got === c.expected, 'got=' + got);
  }
}

// （历史分歧向量 `1.0.0+` 等 4 条已整段删除：它们逐字存在于 shared/version-vectors.json 的
//   versionValidation，上面的 V1 循环已经断言过，原 V3 块是纯重复采样。）

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);