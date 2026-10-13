'use strict';

// 装配集成测试：composeSystem 能否完整跑完，且 agent 域三对象就位。
//
// 这是 agent 域迁移最有力的回归判据——它验证的不是单元行为，
// 而是「删掉 app/native 之后，装配链还完整吗」。
// 此前 CI 只跑单元测试，漏掉了 native-adapter 的 require 路径错误
//（node --check 不解析 require），是靠 esbuild 打包才暴露的。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

let pass = 0;
const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

// 随机高位端口：避开本机已运行实例占用的 37360 等固定端口。
const PORT = 48000 + Math.floor(Math.random() * 5000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-assemble-'));
const cfgPath = path.join(dir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  targetPort: PORT,
  healthUrl: 'http://127.0.0.1:' + PORT + '/health',
  command: ['dsh'],
  stateFile: path.join(dir, 'supervisor', 'state.json'),
  updateCheckEnabled: false,
  tickIntervalMs: 5000,
}, null, 2));

let host = null;
try {
  const { composeSystem } = require('../src/app/assembly/compose');
  const { createServer } = require('../src/api/index');
  host = {};
  composeSystem(host, require(cfgPath), cfgPath, { createServer });
} catch (e) {
  console.log('装配失败: ' + e.message.split(String.fromCharCode(10)).slice(0, 4).join(' | '));
  process.exit(1);
}

check('composeSystem 完整跑完（删 app/native 后装配链仍完整）', () => {
  assert.ok(host, 'host 应被装配');
});

check('三个核心对象就位', () => {
  assert.ok(host.agents, 'AgentManager 应在位');
  assert.ok(host.nativeAgent, 'nativeAgent 适配器应在位');
  assert.ok(host.instances, 'InstanceManager 应在位');
});

check('AgentManager 暴露两种形态', () => {
  assert.deepStrictEqual(host.agents.kinds(), ['native', 'sandbox']);
});

check('nativeAgent 具备 API 依赖的全部方法', () => {
  const need = ['status', 'versionInfo', 'upgradeStatus', 'checkUpdate', 'startInstall', 'upgrade', 'busy', 'startUninstall'];
  const missing = need.filter((m) => typeof host.nativeAgent[m] !== 'function');
  assert.strictEqual(missing.length, 0, '缺: ' + missing.join(','));
});

check('nativeAgent 状态机初值正确', () => {
  assert.strictEqual(host.nativeAgent.upgradeState, 'idle');
  assert.strictEqual(host.nativeAgent.busy(), false);
});

check('nativeAgent.status() 形状可用', () => {
  const st = host.nativeAgent.status();
  assert.ok(st && typeof st === 'object');
  assert.ok('installed' in st, '应有 installed 字段');
  assert.ok('busy' in st, '应有 busy 字段');
});

check('InstanceManager 仍可列举（沙箱实例子系统未受影响）', () => {
  const all = host.instances.all();
  assert.ok(Array.isArray(all));
});

check('InstanceManager 持有 agents（去重后的委托链）', () => {
  assert.ok(host.instances.agents, 'InstanceManager 应持有 agents 引用');
  assert.strictEqual(host.instances.agents, host.agents, '应为同一实例');
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }

console.log('装配集成测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) { console.log(fails.map((f) => '  x ' + f).join(String.fromCharCode(10))); process.exit(1); }
console.log('ALL ASSEMBLY INTEGRATION TESTS PASS');