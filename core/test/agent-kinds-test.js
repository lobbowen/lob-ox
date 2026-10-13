const k = require('C:/work/lob-ox/core/src/domains/agent/kinds.js');
const m = require('C:/work/lob-ox/core/src/domains/agent/model.js');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

check('KINDS 含两种形态', () => {
  assert.deepStrictEqual(k.KINDS, ['native', 'sandbox']);
});
check('isKind 判别', () => {
  assert.strictEqual(k.isKind('native'), true);
  assert.strictEqual(k.isKind('sandbox'), true);
  assert.strictEqual(k.isKind('bogus'), false);
});
check('normalizeKind 缺省 native', () => {
  assert.strictEqual(k.normalizeKind(undefined), 'native');
  assert.strictEqual(k.normalizeKind('sandbox'), 'sandbox');
});
check('capabilities 矩阵', () => {
  assert.strictEqual(k.capabilitiesOf('sandbox').dataIsolation, true);
  assert.strictEqual(k.capabilitiesOf('native').dataIsolation, false);
});
check('normalizeAgent 归一化', () => {
  const s = m.normalizeAgent({ id: 'a1', kind: 'sandbox', port: 3000 });
  assert.strictEqual(s.kind, 'sandbox');
  assert.strictEqual(s.port, 3000);
  const n = m.normalizeAgent({ id: 'a2' });
  assert.strictEqual(n.kind, 'native');
  assert.strictEqual(m.normalizeAgent({}), null, '无 id 应返回 null');
});
check('env 隔离只对 sandbox', () => {
  assert.strictEqual(m.needsEnvIsolation({ kind: 'sandbox' }), true);
  assert.strictEqual(m.needsEnvIsolation({ kind: 'native' }), false);
});
check('数据落点按形态分', () => {
  const path = require('node:path');
  const s = m.normalizeAgent({ id: 'a1', kind: 'sandbox' });
  const n = m.normalizeAgent({ id: 'a2', kind: 'native' });
  const root = path.join('var', 'lib', 'lobox', 'agents');
  assert.strictEqual(m.dataDirOf(root, s), path.join(root, 'a1', 'data'));
  assert.strictEqual(m.dataDirOf(root, n), path.join(root, 'dsh-home'));
  assert.strictEqual(m.installDirOf(root, s), path.join(root, 'a1', 'install'));
  assert.strictEqual(m.installDirOf(root, n), null, 'native 无独立 install 目录');
});
console.log('agent kinds/model 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
console.log('ALL AGENT KINDS TESTS PASS');