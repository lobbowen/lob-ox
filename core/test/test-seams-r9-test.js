'use strict';
// R9：测试缝导出的可达性断言。
// 这些导出（_test / _parse / _testProviders / _lockPrimitives）在 src 内零消费方，
// 专为测试注入而存在。若它们失效，相关模块的可测性就悄悄消失——本测试守住这条。
const assert = require('node:assert');

let passed = 0;
const failures = [];
function check(n, f) { try { f(); passed++; } catch (e) { failures.push(n + ': ' + e.message); } }

check('portable._test 缝可用', () => {
  const m = require('C:/work/lob-ox/core/src/platform/os/portable.js');
  assert.ok(m._test, '应有 _test 导出');
  assert.strictEqual(typeof m._test.readPidFile, 'function');
  assert.strictEqual(typeof m._test.findOurs, 'function');
  assert.strictEqual(typeof m._test.matchesAnchors, 'function');
});

check('resstats._parse 缝可用', () => {
  const m = require('C:/work/lob-ox/core/src/platform/os/resstats.js');
  assert.ok(m._parse, '应有 _parse 导出');
  for (const k of ['parseProcStat', 'parseProcStatusRss', 'parseCpuTimeMs', 'parsePsTable', 'parseCimJson']) {
    assert.strictEqual(typeof m._parse[k], 'function', '缺 ' + k);
  }
});

check('service._testProviders 缝可用', () => {
  const m = require('C:/work/lob-ox/core/src/platform/os/service.js');
  assert.ok(m._testProviders, '应有 _testProviders 导出');
  assert.strictEqual(m._testProviders.portable.kind, 'portable');
  assert.ok(m._testProviders.NONE, '应有 NONE provider');
});

check('identity._lockPrimitives 缝可用', () => {
  const m = require('C:/work/lob-ox/core/src/app/daemons/identity.js');
  assert.ok(m._lockPrimitives, '应有 _lockPrimitives 导出');
  assert.strictEqual(typeof m._lockPrimitives.acquireLock, 'function');
  assert.strictEqual(typeof m._lockPrimitives.releaseLock, 'function');
});

check('input LEDGER_UNSAFE_KEYS_RE 命名一致且可用', () => {
  const m = require('C:/work/lob-ox/core/src/platform/util/input.js');
  assert.ok(m.LEDGER_UNSAFE_KEYS_RE instanceof RegExp, '应是正则');
  assert.strictEqual(m.LEDGER_UNSAFE_KEYS_RE.test('a b'), true, '空白应判不安全');
  assert.strictEqual(m.LEDGER_UNSAFE_KEYS_RE.test('abc'), false, '普通键应安全');
});

console.log('R9 测试缝断言：' + passed + ' 通过，' + failures.length + ' 失败');
if (failures.length) { console.log(failures.map((f) => '  x ' + f).join('\n')); process.exit(1); }
console.log('ALL R9 TEST-SEAM ASSERTIONS PASS');