'use strict';

// R9-1 契约断言测试（第一批）：把审计中发现的六套声明式契约全部变成可执行断言。
// 目标不是覆盖率，而是「审计报告里每一条契约类缺陷都有一个对应判据」。
//
// 覆盖的缺陷：
//   D.7-P1-5   UI EVENT_LABELS 只覆盖 61/116 个事件类型
//   D.7-P1-6   core/shared/version-vectors.json 内核侧零消费
//   D.6-P2-18  ctl eventsTail 无 limit
//   D.8-P2-8   contract/runtime.js 不校验 schema
//   D.11-P2-14 router contract.js 的 classApi 漏声明
//   主报告 P1-1 五个域 contract.js 零消费（本文档即消费方）
//
// 运行：node core/test/contract-assertions-test.js

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'core', 'src');
const DOMAINS = path.join(SRC, 'domains');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed += 1; }
  catch (e) {
    failures.push(name + '\n    ' + (e && e.message ? e.message.split('\n').slice(0, 6).join('\n    ') : String(e)));
  }
}

function walk(dir, base, acc) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name === '.git' || it.name === 'target' || it.name === 'dist') continue;
    const p = path.join(dir, it.name);
    const rel = base ? base + '/' + it.name : it.name;
    if (it.isDirectory()) walk(p, rel, acc); else acc.push(p);
  }
}

check('域 contract.exports === index.js 实际导出', () => {
  const diffs = [];
  for (const d of fs.readdirSync(DOMAINS)) {
    const cpath = path.join(DOMAINS, d, 'contract.js');
    const ipath = path.join(DOMAINS, d, 'index.js');
    if (!fs.existsSync(cpath) || !fs.existsSync(ipath)) continue;
    const contract = fs.readFileSync(cpath, 'utf8');
    const m = contract.match(/exports:\s*\[([\s\S]*?)\]/);
    const declared = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    const actual = Object.keys(require(ipath));
    const missing = declared.filter((x) => !actual.includes(x));
    if (missing.length) diffs.push(d + ': contract 声明但 index 未导出 -> ' + missing.join(', '));
  }
  assert.strictEqual(diffs.length, 0, diffs.join('\n'));
});

check('router contract.classApi === RouterService 实际方法', () => {
  const contract = require(path.join(DOMAINS, 'router', 'contract.js'));
  const { RouterService } = require(path.join(DOMAINS, 'router', 'index.js'));
  const api = (contract && contract.classApi && contract.classApi.RouterService) || [];
  const proto = Object.getOwnPropertyNames(RouterService.prototype).filter((n) => n !== 'constructor');
  const missing = api.filter((n) => !proto.includes(n));
  const undeclared = proto.filter((n) => !api.includes(n) && !/^_/.test(n));
  assert.strictEqual(missing.length, 0,
    'classApi 声明但类上不存在: ' + missing.join(', ') +
    (undeclared.length ? '\n    类上公开但 classApi 未声明: ' + undeclared.join(', ') : ''));
});

check('api SURFACE 每条 path 都被 owns() 覆盖', () => {
  const { SURFACE, PREFIXES } = require(path.join(SRC, 'api', 'contract.js'));
  const domains = require(path.join(SRC, 'api', 'router-table.js')).API_DOMAINS;
  const prefixes = (PREFIXES || []).map((p) => (typeof p === 'string' ? p : p && p.prefix)).filter(Boolean);
  const orphans = (SURFACE || [])
    .map((e) => (typeof e === 'string' ? e : e && e.path))
    .filter((p) => p && !domains.some((d) => typeof d.owns === 'function' && d.owns(p))
      && !prefixes.some((pre) => p === pre || p.startsWith(pre)));
  assert.strictEqual(orphans.length, 0, 'SURFACE 声明但无 domain owns 命中: ' + orphans.join(', '));
});

check('api 每个 domain 都有 owns 与 handle', () => {
  const domains = require(path.join(SRC, 'api', 'router-table.js')).API_DOMAINS;
  const bad = domains.filter((d) => typeof d.owns !== 'function' || typeof d.handle !== 'function');
  assert.strictEqual(bad.length, 0, 'domain 缺 owns/handle: ' + bad.length + ' 个');
});

check('core emit 的事件类型都被 UI EVENT_LABELS 覆盖', () => {
  const all = [];
  walk(SRC, '', all);
  const emitted = new Set();
  const brandSrc = fs.readFileSync(path.join(SRC, 'shared', 'brand.js'), 'utf8');
  const brandMap = {};
  for (const m of brandSrc.matchAll(/const (EVENT_\w+)\s*=\s*['"]([a-z_0-9]+)['"]/g)) brandMap[m[1]] = m[2];
  for (const f of all) {
    if (!f.endsWith('.js')) continue;
    const c = fs.readFileSync(f, 'utf8');
    for (const m of c.matchAll(/events?\.append\(\s*['"]([a-z_0-9]+)['"]/g)) emitted.add(m[1]);
    for (const m of c.matchAll(/events?\.append\(\s*BRAND\.(EVENT_\w+)/g)) {
      if (brandMap[m[1]]) emitted.add(brandMap[m[1]]);
    }
  }
  const nav = fs.readFileSync(path.join(ROOT, 'core', 'ui', 'src', 'features', 'supervisor', 'nav.ts'), 'utf8');
  const block = nav.match(/EVENT_LABELS[^=]*=\s*\{([\s\S]*?)\n\}/);
  const labeled = new Set(block ? [...block[1].matchAll(/([a-z_0-9]+)\s*:\s*"/g)].map((m) => m[1]) : []);
  const uncovered = [...emitted].filter((t) => !labeled.has(t)).sort();
  assert.strictEqual(uncovered.length, 0,
    uncovered.length + ' 个事件类型无中文标签（用户时间线看到原始英文 type）:\n    ' + uncovered.join('\n    '));
});

check('Node semverCompare/VERSION_RE 符合 26 条版本向量', () => {
  const vv = require(path.join(ROOT, 'core', 'shared', 'version-vectors.json'));
  const { semverCompare, VERSION_RE } = require(path.join(SRC, 'shared', 'version.js'));
  const bad = [];
  for (const c of vv.versionValidation || []) {
    if (VERSION_RE.test(c.input) !== c.valid) bad.push('versionValidation ' + JSON.stringify(c.input) + ' 期望 ' + c.valid);
  }
  for (const c of vv.compare || []) {
    if (Math.sign(semverCompare(c.a, c.b)) !== c.expected) bad.push('compare ' + c.a + ' vs ' + c.b + ' 期望 ' + c.expected);
  }
  assert.strictEqual(bad.length, 0, bad.join('\n    '));
});

check('version-vectors.json 两份副本一致（收敛为单源前的过渡断言）', () => {
  const a = fs.readFileSync(path.join(ROOT, 'core', 'shared', 'version-vectors.json'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'shell', 'shell-release', 'version-vectors.json'), 'utf8');
  assert.strictEqual(a, b, '两份 version-vectors.json 已漂移，按 R8 方案应收敛为单源');
});

check('THIN_SPEC 与 HELPERS 装配期自检在位', () => {
  const collab = fs.readFileSync(path.join(SRC, 'app', 'assembly', 'collaborators.js'), 'utf8');
  assert.ok(/assertCollaboratorTargets/.test(collab), 'collaborators.js 应有 assertCollaboratorTargets');
  assert.ok(/THIN_SPEC/.test(collab), 'collaborators.js 应有 THIN_SPEC 接口表');
  const proc = fs.readFileSync(path.join(SRC, 'app', 'main', 'process.js'), 'utf8');
  assert.ok(/HELPERS/.test(proc), 'main/process.js 应有 HELPERS 就地校验');
});

check('ctl eventsTail 有 limit 上限', () => {
  const srv = fs.readFileSync(path.join(SRC, 'platform', 'ctl', 'server.js'), 'utf8');
  const m = srv.match(/events\.tailSince\(([^)]*)\)/);
  assert.ok(m, '未找到 events.tailSince 调用');
  assert.ok(/limit|args\[1\]/.test(m[1]),
    'eventsTail 调 tailSince 未传 limit，watermark 重置那一拍会把整个事件文件序列化进 HTTP 响应');
});

check('contract/runtime.js 的 read() 校验 schema 版本', () => {
  const rt = fs.readFileSync(path.join(SRC, 'platform', 'contract', 'runtime.js'), 'utf8');
  assert.ok(/SUPPORTED_SCHEMA/.test(rt) && /schema[\s\S]{0,80}SUPPORTED_SCHEMA|SUPPORTED_SCHEMA[\s\S]{0,80}schema/.test(rt),
    'runtime.js 定义了 SUPPORTED_SCHEMA 但 read() 未用它校验，schema 3 的字段改名会被静默误读');
});

console.log('契约断言测试：' + passed + ' 通过，' + failures.length + ' 失败');
if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) console.log('  x ' + f);
  process.exit(1);
}
console.log('ALL CONTRACT ASSERTIONS PASS');
