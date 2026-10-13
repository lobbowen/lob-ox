const st = require('C:/work/lob-ox/core/src/domains/agent/status.js');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

check('busy 只看 upgradeState 是否终态', () => {
  assert.strictEqual(st.busy({ upgradeState: 'idle' }), false);
  assert.strictEqual(st.busy({ upgradeState: 'done' }), false);
  assert.strictEqual(st.busy({ upgradeState: 'failed' }), false);
  assert.strictEqual(st.busy({ upgradeState: 'installing' }), true);
  assert.strictEqual(st.busy({}), true, '缺省按忙处理（保守）');
});
check('assertNotBusy 覆盖四种互斥', () => {
  assert.ok(st.assertNotBusy({ upgradeState: 'idle', taskBusy: true }, 'install'), 'taskBusy 应拒');
  assert.ok(st.assertNotBusy({ upgradeState: 'idle', installing: true }, 'install'), 'installing 应拒');
  assert.ok(st.assertNotBusy({ upgradeState: 'idle', uninstalling: true }, 'install'), 'uninstalling 应拒');
  assert.ok(st.assertNotBusy({ upgradeState: 'installing' }, 'install'), '升级中应拒');
  assert.strictEqual(st.assertNotBusy({ upgradeState: 'idle' }, 'install'), null, '空闲应放行');
});
check('assertNotBusy 按 action 给不同文案', () => {
  const a = st.assertNotBusy({ upgradeState: 'idle', uninstalling: true }, 'install');
  const b = st.assertNotBusy({ upgradeState: 'idle', uninstalling: true }, 'uninstall');
  assert.notStrictEqual(a.error, b.error, '不同动作文案应不同');
});
check('isBareCommand 不假设产品名', () => {
  assert.strictEqual(st.isBareCommand(undefined), true);
  assert.strictEqual(st.isBareCommand('dsh'), true);
  assert.strictEqual(st.isBareCommand('anything'), true, '任何裸名都算 bare（与产品名无关）');
  assert.strictEqual(st.isBareCommand('/usr/bin/dsh'), false, '含路径分隔不算 bare');
  assert.strictEqual(st.isBareCommand('C:' + String.fromCharCode(92) + 'dsh.exe'), false, 'Windows 盘符路径不算 bare');
  assert.strictEqual(st.isBareCommand('~/bin/dsh'), false, '~ 开头不算 bare');
});
check('版本比较三件套', () => {
  assert.strictEqual(st.isNewer('1.0.1', '1.0.0'), true);
  assert.strictEqual(st.isNewer('1.0.0', '1.0.1'), false);
  assert.strictEqual(st.isUpToDate('1.0.0', '1.0.0'), true);
  assert.strictEqual(st.isUpToDate('1.0.1', '1.0.0'), false);
});
check('isValidVersion 空值放行（未锁定版本）', () => {
  assert.strictEqual(st.isValidVersion(''), true);
  assert.strictEqual(st.isValidVersion(null), true);
  assert.strictEqual(st.isValidVersion('1.2.3'), true);
  assert.strictEqual(st.isValidVersion('abc'), false);
});
check('needsRollback 需显式开启', () => {
  assert.strictEqual(st.needsRollback({ upgradeAutoRollback: true }, '1.0.0', '1.0.1'), true);
  assert.strictEqual(st.needsRollback({ upgradeAutoRollback: false }, '1.0.0', '1.0.1'), false);
  assert.strictEqual(st.needsRollback({}, '1.0.0', '1.0.1'), true, '缺省开启');
  assert.strictEqual(st.needsRollback({}, null, '1.0.1'), false, '无旧版本不回滚');
  assert.strictEqual(st.needsRollback({}, '1.0.0', '1.0.0'), false, '版本未变不回滚');
});
check('versionInfo 回退到探到的版本', () => {
  const v = st.versionInfo({ lastCheck: { installed: '1.0.1', latest: '1.0.2', updateAvailable: true, at: 123 } }, '0.9.0');
  assert.strictEqual(v.installed, '1.0.1');
  assert.strictEqual(v.updateAvailable, true);
  const v2 = st.versionInfo({ lastCheck: {} }, '0.9.0');
  assert.strictEqual(v2.installed, '0.9.0', 'lastCheck 空时应回退');
  const v3 = st.versionInfo({}, null);
  assert.strictEqual(v3.installed, null);
});
check('upgradeBrief 字段名与原实现一致（UI 免改）', () => {
  const b = st.upgradeBrief({ upgradeState: 'done', targetVersion: '1.0.2', upgradeStartedAt: 1, upgradeFinishedAt: 2, upgradeError: null, rolledBack: false });
  assert.deepStrictEqual(Object.keys(b).sort(), ['finishedAt', 'lastError', 'rolledBack', 'startedAt', 'state', 'targetVersion']);
});
console.log('agent status 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
console.log('ALL AGENT STATUS TESTS PASS');