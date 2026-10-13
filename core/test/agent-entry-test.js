const entry = require('C:/work/lob-ox/core/src/domains/agent/ops/entry.js');
const { AgentManager } = require('C:/work/lob-ox/core/src/domains/agent/index.js');
const path = require('node:path');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

const root = path.join('var', 'lib', 'lobox', 'agents');
const sandboxAgent = { id: 'a1', kind: 'sandbox' };
const nativeAgent = { id: 'a2', kind: 'native' };

check('sandboxEntry 按 installDir 拼 DSH 本体路径', () => {
  const installDir = path.join(root, 'a1', 'install');
  const e = entry.sandboxEntry(installDir);
  assert.ok(e, '应返回入口路径');
  assert.ok(e.includes('node_modules'), '应含 node_modules: ' + e);
  assert.ok(e.includes('bin.js'), '应以 bin.js 结尾: ' + e);
  assert.ok(e.startsWith(installDir), '应在 installDir 下: ' + e);
});
check('sandboxEntry 缺 installDir 返回 null（不猜）', () => {
  assert.strictEqual(entry.sandboxEntry(null), null);
  assert.strictEqual(entry.sandboxEntry(''), null);
});
check('entryOf 对 sandbox 用每实例 installDir', () => {
  const got = entry.entryOf(sandboxAgent, { root });
  assert.ok(Array.isArray(got));
  assert.strictEqual(got.length, 1, 'sandbox 应只有一个确定性入口');
  assert.ok(got[0].includes(path.join('a1', 'install')), '应指向 a1 的 install: ' + got[0]);
});
check('entryOf 对 native 走候选列表', () => {
  const got = entry.entryOf(nativeAgent, { root });
  assert.ok(Array.isArray(got), 'native 返回候选数组');
  // 本机未必装了 DSH，故不断言长度；但必须是数组且元素为字符串
  for (const g of got) assert.strictEqual(typeof g, 'string');
});
check('entryOf 无 agent 返回 null', () => {
  assert.strictEqual(entry.entryOf(null, { root }), null);
});
check('nativeCandidates 不抛错（未装 DSH 时返回空数组）', () => {
  const got = entry.nativeCandidates({});
  assert.ok(Array.isArray(got));
});
check('门面 entryOf 委托 ops 并注入 root', () => {
  const m = new AgentManager({ root, logger: { warn() {} } });
  m._register({ id: 'a1', kind: 'sandbox' });
  const a = m.find('a1');
  const got = m.entryOf(a);
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].includes(path.join('a1', 'install')));
});
check('commandViolation 委托 platform（不重复规则）', () => {
  // node + 绝对路径 JS = 合法；裸 dsh = 需 platform 判定，这里只验证不抛错
  const v1 = entry.commandViolation([process.execPath, path.join('abs', 'bin.js')], {});
  assert.ok(v1 === null || typeof v1 === 'string', '应返回 null 或违规说明');
});
console.log('agent ops/entry 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
console.log('ALL AGENT ENTRY TESTS PASS');