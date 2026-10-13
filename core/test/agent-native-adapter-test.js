const { NativeAgentAdapter } = require('C:/work/lob-ox/core/src/domains/agent/native-adapter.js');
const assert = require('node:assert');
let pass = 0; const fails = [];
const ASYNC = [];
function check(n, f) {
  const r = f();
  if (r && typeof r.then === 'function') { ASYNC.push([n, r]); return; }
  pass++;
}

// 假 AgentManager：记录收到的调用，返回可控结果
function mkAgents(o) {
  o = o || {};
  const calls = [];
  return {
    calls,
    async checkUpdate(agent, opts) { calls.push(['checkUpdate', agent, opts]); return o.checkUpdate || { ok: true, installed: '1.0.0', latest: '2.0.0', updateAvailable: true }; },
    async install(agent, opts) { calls.push(['install', agent, opts]); return o.install || { ok: true }; },
    async upgrade(agent, opts) { calls.push(['upgrade', agent, opts]); return o.upgrade || { ok: true, result: 'upgraded', from: '1.0.0', to: '2.0.0' }; },
    async uninstall(agent, opts) {
      calls.push(['uninstall', agent, opts]);
      // 纯记录 + 可控返回：真实 AgentManager 会碰文件系统，
      // 测试机上真删 /usr/local/lib 是不可接受的。
      // safeAncestors 判据本身由 agent-manager-test 与 agent-uninstall-test 覆盖。
      return o.uninstall || { ok: true, removed: [] };
    },
  };
}

function mkAdapter(o) {
  const agents = mkAgents(o);
  const ad = new NativeAgentAdapter({
    agents,
    config: { packageName: '@lob-ox/dsh', targetPort: 37360, command: ['node', 'dsh'] },
    dist: o && o.dist,
    npmRoot: o && o.npmRoot,
    tasks: o && o.tasks,
    events: o && o.events,
    logger: { info() {}, warn() {} },
    hooks: (o && o.hooks) || {},
  });
  return { ad, agents };
}

check('形状：API 消费的 9 个方法都在', () => {
  const { ad } = mkAdapter({});
  for (const m of ['status', 'versionInfo', 'upgradeStatus', 'checkUpdate', 'startInstall', 'upgrade', 'busy', 'startUninstall', 'installedVersion', 'binPath', 'detected']) {
    assert.strictEqual(typeof ad[m], 'function', '缺方法 ' + m);
  }
});

check('upgradeState 可被 API 直读', () => {
  const { ad } = mkAdapter({});
  assert.strictEqual(ad.upgradeState, 'idle');
});

check('busy 与 status 联动', () => {
  const { ad } = mkAdapter({});
  assert.strictEqual(ad.busy(), false);
  assert.strictEqual(ad.status().busy, false);
  ad.upgradeState = 'installing';
  assert.strictEqual(ad.busy(), true);
});

check('versionInfo 委托 status.versionInfo', () => {
  const { ad } = mkAdapter({});
  ad.lastCheck = { installed: '1.0.0', latest: '2.0.0', updateAvailable: true };
  const v = ad.versionInfo();
  assert.strictEqual(v.installed, '1.0.0');
  assert.strictEqual(v.updateAvailable, true);
});

check('upgradeStatus 带 logTail', () => {
  const { ad } = mkAdapter({});
  ad.upgradeLog = ['a', 'b'];
  const s = ad.upgradeStatus();
  assert.deepStrictEqual(s.logTail, ['a', 'b']);
});

check('checkUpdate 写 lastCheck（versionInfo 依赖它）', async () => {
  const { ad } = mkAdapter({});
  await ad.checkUpdate();
  assert.ok(ad.lastCheck, '应记录 lastCheck');
  assert.strictEqual(ad.lastCheck.latest, '2.0.0');
  assert.strictEqual(ad.versionInfo().latest, '2.0.0');
});

check('startInstall 非法版本拒绝', () => {
  const { ad } = mkAdapter({});
  const r = ad.startInstall('bogus');
  assert.strictEqual(r.ok, false);
  assert.ok(/非法版本号/.test(r.error));
});

check('startInstall 忙时拒绝', () => {
  const { ad } = mkAdapter({});
  ad.upgradeState = 'installing';
  const r = ad.startInstall('1.2.3');
  assert.strictEqual(r.ok, false);
});

check('startUninstall 忙时拒绝', () => {
  const { ad } = mkAdapter({});
  ad.upgradeState = 'installing';
  const r = ad.startUninstall();
  assert.strictEqual(r.ok, false);
});

check('upgrade 走 AgentManager 且状态机推进', async () => {
  const { ad, agents } = mkAdapter({});
  const r = await ad.upgrade(null);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(ad.upgradeState, 'done');
  assert.ok(ad.upgradeFinishedAt);
  const call = agents.calls.find(c => c[0] === 'upgrade');
  assert.ok(call, '应调用 agents.upgrade');
  assert.strictEqual(call[1].kind, 'native', 'agent.kind 应为 native');
  // env 必须齐备（否则 upgrade 会跳过进程停/拉）
  const env = call[2].env;
  for (const k of ['installedVersion', 'latestVersion', 'install', 'selectRegistry', 'isActive', 'stopForUpgrade', 'resume', 'desiredRunning', 'waitHealthy', 'targetPort']) {
    assert.ok(env[k], 'env 缺 ' + k);
  }
});

check('upgrade 失败时状态机落 failed 且记 error', async () => {
  const { ad } = mkAdapter({ upgrade: { ok: false, error: 'boom' } });
  const r = await ad.upgrade(null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(ad.upgradeState, 'failed');
  assert.strictEqual(ad.upgradeError, 'boom');
});

check('upgrade 回滚标记从错误信息识别', async () => {
  const { ad } = mkAdapter({ upgrade: { ok: false, error: '升级失败，已回滚到 1.0.0' } });
  await ad.upgrade(null);
  assert.strictEqual(ad.rolledBack, true);
});

check('uninstall 用 npmRoot 作安全边界', async () => {
  const { ad, agents } = mkAdapter({ npmRoot: '/usr/local/lib' });
  const r = await ad.uninstall();
  assert.strictEqual(r.ok, true);
  const call = agents.calls.find(c => c[0] === 'uninstall');
  assert.deepStrictEqual(call[2].safeAncestors, ['/usr/local/lib']);
});

check('uninstall 无 npmRoot 时传空 safeAncestors（由 agent 域拒绝）', async () => {
  const { ad, agents } = mkAdapter({});
  await ad.uninstall();
  const call = agents.calls.find(c => c[0] === 'uninstall');
  assert.deepStrictEqual(call[2].safeAncestors, [], '无 npmRoot 应传空数组而非 undefined');
  // 空数组的拒绝语义由 agent 域保证（见 agent-manager-test）
});

check('startUninstall 忙门禁用 status 判定', () => {
  const { ad } = mkAdapter({});
  ad.uninstalling = true;
  const r = ad.startUninstall();
  assert.strictEqual(r.ok, false);
});

check('_targetPort 从 config.targetPort 取', () => {
  const { ad } = mkAdapter({});
  assert.strictEqual(ad._targetPort(), 37360);
});

check('_targetPort 缺 targetPort 时从 healthUrl 解析', () => {
  const agents = mkAgents({});
  const ad = new NativeAgentAdapter({
    agents, config: { packageName: 'p', healthUrl: 'http://127.0.0.1:9999/health' },
    logger: { info() {}, warn() {} },
  });
  assert.strictEqual(ad._targetPort(), 9999);
});

(async () => {
  for (const [n, pr] of ASYNC) {
    try { await pr; pass++; } catch (e) { fails.push(n + ': ' + e.message); }
  }
  console.log('native-adapter 形状/行为测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
  if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL NATIVE ADAPTER TESTS PASS');
})();