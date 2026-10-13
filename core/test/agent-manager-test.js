const { AgentManager } = require('C:/work/lob-ox/core/src/domains/agent/index.js');
const assert = require('node:assert');
let pass = 0; const fails = [];
const ASYNC = [];
// 同步断言立即执行；async 断言收进 ASYNC 由末尾统一 await。
// 不能让 async 断言以「fire-and-forget」方式跑——失败会变成未捕获 rejection，
// 输出显示全 PASS 而退出码非零，是最难发现的一种测试假象。
function check(n, f) {
  const r = f();
  if (r && typeof r.then === 'function') { ASYNC.push([n, r]); return; }
  pass++;
}
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
  for (const fn of ['start', 'stop']) {
    assert.throws(() => m[fn]({ id: 'x' }), /待 .* 实现/, fn + ' 应明确抛错');
  }
});
check('entryOf 已实现（ops/entry 接入）且不抛错', () => {
  const a = m.find('a1');
  const got = m.entryOf(a);
  assert.ok(Array.isArray(got), 'entryOf 应返回数组');
  assert.strictEqual(got.length, 1);
});

check('install 已实现：沙箱形态用每实例 prefix 且不猜包名', async () => {
  const calls = [];
  const dist = { async runNpmInstall(o) { calls.push(o); return { ok: true }; } };
  const r = await m.install({ id: 'a1', kind: 'sandbox', product: '@lob-ox/dsh' }, { dist });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls[0].pkg, '@lob-ox/dsh', '包名应来自 agent.product');
  assert.ok(calls[0].prefix.includes('a1'), 'prefix 应是 a1 的 installDir');
});

check('install 原生形态缺 npmRoot 时明确报错', async () => {
  const r = await m.install({ id: 'a2', kind: 'native', product: '@lob-ox/dsh' }, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/npmRoot/.test(r.error), '错误应指出需 npmRoot: ' + r.error);
});

check('checkUpdate 已实现并报告 updateAvailable', async () => {
  const dist = { async fetchNpmLatest() { return { ok: true, version: '2.0.0', origin: 'r' }; } };
  const r = await m.checkUpdate({ id: 'a1', kind: 'sandbox', product: '@lob-ox/dsh' }, { dist, installed: '1.0.0' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.installed, '1.0.0');
  assert.strictEqual(r.latest, '2.0.0');
  assert.strictEqual(r.updateAvailable, true);
  const r2 = await m.checkUpdate({ id: 'a1', kind: 'sandbox', product: '@lob-ox/dsh' }, { dist, installed: '2.0.0' });
  assert.strictEqual(r2.updateAvailable, false, '已是最新不应报可更新');
});

check('upgrade 已实现：env 全缺省时用 installToPrefix 兜底', async () => {
  const installs = [];
  // 桩必须模拟「安装后磁盘版本真的变了」——否则 installToPrefix 是假的，
  // installedVersion 永远返回 1.0.0，会被 upgrade 的安装后校验挡住。
  const disk = { v: '1.0.0' };
  const env = {
    installedVersion: () => disk.v,
    isActive: () => false,
    desiredRunning: () => false,   // 期望停机 → 不做健康验证
  };
  const dist2 = {
    async runNpmInstall(o) { installs.push(o); disk.v = o.version || disk.v; return { ok: true }; },
    async fetchNpmLatest() { return { ok: true, version: '2.0.0', origin: 'r' }; },
  };
  const r = await m.upgrade({ id: 'a1', kind: 'sandbox', product: '@lob-ox/dsh' }, { env, dist: dist2 });
  assert.strictEqual(r.ok, true, '应成功: ' + r.error);
  assert.strictEqual(r.result, 'installed');
  assert.strictEqual(installs.length, 1);
  assert.strictEqual(installs[0].version, '2.0.0');
  assert.ok(installs[0].prefix.includes('a1'), 'prefix 应为 a1 的 installDir');
});

check('upgrade 已是最新则跳过', async () => {
  const installs = [];
  const dist = { async runNpmInstall(o) { installs.push(o); return { ok: true }; } };
  const env = { installedVersion: () => '2.0.0', latestVersion: async () => ({ ok: true, version: '2.0.0' }) };
  const r = await m.upgrade({ id: 'a1', kind: 'sandbox', product: '@lob-ox/dsh' }, { env, dist });
  assert.strictEqual(r.result, 'up-to-date');
  assert.strictEqual(installs.length, 0, '不应安装');
});

check('upgradeStatus 委托 status.upgradeBrief（字段名兼容）', () => {
  const b = m.upgradeStatus({ id: 'a1' }, { upgradeState: 'done', targetVersion: '2.0.0' });
  assert.strictEqual(b.state, 'done');
  assert.strictEqual(b.targetVersion, '2.0.0');
});

check('uninstall 已实现：缺 safeAncestors 拒绝删', async () => {
  const r = await m.uninstall({ id: 'a1', kind: 'sandbox', product: '@lob-ox/dsh' }, { safeAncestors: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(/safeAncestors/.test(r.error));
});

check('uninstall 沙箱形态自动推安全边界', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const m2 = new AgentManager({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-facade-')), logger: { warn() {} } });
  m2._register({ id: 'x1', kind: 'sandbox' });
  const r = await m2.uninstall(m2.find('x1'), {});
  assert.strictEqual(r.ok, true, '空目录也应成功: ' + r.error);
  assert.ok(Array.isArray(r.removed));
  fs.rmSync(m2.root, { recursive: true, force: true });
});

check('status 已实现：组合 versionInfo 与 phase', () => {
  const s = m.status({ id: 'a1' }, { lastCheck: { installed: '1.0.0', latest: '1.1.0', updateAvailable: true }, phase: 'RUNNING', upgradeState: 'idle' });
  assert.strictEqual(s.installed, '1.0.0');
  assert.strictEqual(s.updateAvailable, true);
  assert.strictEqual(s.phase, 'RUNNING');
  assert.strictEqual(s.busy, false);
});

check('dataDirOf/installDirOf 委托 model', () => {
  const a = m.find('a1');
  assert.ok(m.dataDirOf(a).includes('a1'));
  assert.ok(m.installDirOf(a).includes('a1'));
});
(async () => {
  for (const [n, pr] of ASYNC) {
    try { await pr; pass++; } catch (e) { fails.push(n + ': ' + e.message); }
  }
  console.log('agent 门面测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
  if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL AGENT MANAGER TESTS PASS');
})();