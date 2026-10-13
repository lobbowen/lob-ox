const { AgentManager } = require('C:/work/lob-ox/core/src/domains/agent/index.js');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }
const m = new AgentManager({ root: '/tmp/agents', logger: { warn() {} } });
check('kinds 暴露两种形态', () => {
  assert.deepStrictEqual(m.kinds(), ['native', 'sandbox']);
});
check('_register 归一化并登记', () => {
  const a = m._register({ id: 'a1', kind: 'sandbox', port: 3000 });
  assert.strictEqual(a.kind, 'sandbox');
  assert.strictEqual(m.find('a1').id, 'a1');
  assert.strictEqual(m.find('nope'), null);
});
check('inventory 带能力矩阵与落点', () => {
  const inv = m.inventory();
  assert.strictEqual(inv.length, 1);
  assert.strictEqual(inv[0].capabilities.dataIsolation, true);
  assert.ok(inv[0].dataDir.includes('a1'));
  assert.ok(inv[0].installDir.includes('a1'));
});
check('未实现的 ops 明确抛错（不静默返回 undefined）', () => {
  for (const fn of ['install', 'uninstall', 'upgrade', 'start', 'stop', 'status', 'checkUpdate', 'upgradeStatus']) {
    assert.throws(() => m[fn]({ id: 'x' }), /待 .* 实现/, fn + ' 应明确抛错');
  }
});
check('entryOf 已实现（ops/entry 接入）且不抛错', () => {
  const a = m.find('a1');
  const got = m.entryOf(a);
  assert.ok(Array.isArray(got), 'entryOf 应返回数组');
  assert.strictEqual(got.length, 1);
});

check('dataDirOf/installDirOf 委托 model', () => {
  const a = m.find('a1');
  assert.ok(m.dataDirOf(a).includes('a1'));
  assert.ok(m.installDirOf(a).includes('a1'));
});
console.log('agent 门面测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
console.log('ALL AGENT MANAGER TESTS PASS');