const { upgrade, PHASES } = require('C:/work/lob-ox/core/src/domains/agent/ops/upgrade.js');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

// 构造一个可操控的 env：磁盘版本、安装行为、健康验证结果全可注入
function mkEnv(o) {
  o = o || {};
  const calls = { installs: [], stops: 0, resumes: 0, manifests: [] };
  const eventLog = [];
  const logs = [];
  const state = { disk: o.disk || null };
  const env = {
    calls, logs, state,
    // events 先占位，末尾统一替换为账本对象（见函数末尾）
    log(m) { logs.push(m); },
    installedVersion() { return state.disk; },
    latestVersion: o.latestVersion || (async () => ({ ok: true, version: o.latest || '2.0.0', origin: 'reg' })),
    async install(v) { calls.installs.push(v); state.disk = (o.installSets || {}).hasOwnProperty(v) ? o.installSets[v] : v; return { ok: true }; },
    selectRegistry: async () => 'reg',
    async recordManifest(v) { calls.manifests.push(v); },
    isActive: () => o.active === true,
    async stopForUpgrade() { calls.stops++; },
    async resume() { calls.resumes++; },
    desiredRunning: () => o.desiredRunning !== false,
    waitHealthy: o.waitHealthy || (async () => ({ ok: true })),
    targetPort: () => o.port || 3000,
    verifyDeadlineMs: () => 1000,
  };
  // 账本对象：append 记录进 eventLog；测试通过 e.eventsLog 读
  env.events = { append(type, data) { eventLog.push({ type, data }); } };
  env.eventsLog = eventLog;
  return env;
}

check('PHASES 与原 upgradeState 取值一致（UI 免改）', () => {
  assert.deepStrictEqual(PHASES, ['idle', 'installing', 'restarting', 'verifying', 'rolling_back', 'done', 'failed']);
});

check('非法版本号直接拒绝', async () => {
  const r = await upgrade(mkEnv({ disk: '1.0.0' }), 'not-a-version', {});
  assert.strictEqual(r.ok, false);
  assert.ok(/非法版本号/.test(r.error));
});

check('已是最新则跳过，不安装', async () => {
  const e = mkEnv({ disk: '2.0.0', latest: '2.0.0' });
  const r = await upgrade(e, null, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result, 'up-to-date');
  assert.strictEqual(e.calls.installs.length, 0, '不应触发安装');
  assert.ok(e.eventsLog.some(x => x.type === 'upgrade_skipped'));
});

check('正常升级：停→装→验证→done，且事件齐全', async () => {
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: true });
  const r = await upgrade(e, null, {});
  assert.strictEqual(r.ok, true, '应成功: ' + r.error);
  assert.strictEqual(r.result, 'upgraded');
  assert.strictEqual(r.from, '1.0.0');
  assert.strictEqual(r.to, '2.0.0');
  assert.strictEqual(e.calls.stops, 1, '应停一次进程');
  assert.strictEqual(e.calls.resumes, 1, '应拉起一次');
  assert.deepStrictEqual(e.calls.installs, ['2.0.0']);
  assert.deepStrictEqual(e.calls.manifests, ['2.0.0'], '应落 manifest');
  const types = e.eventsLog.map(x => x.type);
  for (const t of ['upgrade_started', 'upgrade_stopping_harness', 'upgrade_installed', 'upgrade_done']) {
    assert.ok(types.includes(t), '缺事件 ' + t);
  }
});

check('进程未在跑则不停', async () => {
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: false });
  await upgrade(e, null, {});
  assert.strictEqual(e.calls.stops, 0, '未激活不应停');
  assert.ok(!e.eventsLog.some(x => x.type === 'upgrade_stopping_harness'));
});

check('未安装过则走全新安装路径', async () => {
  const e = mkEnv({ disk: null, latest: '1.0.0' });
  const r = await upgrade(e, null, {});
  assert.strictEqual(r.ok, true);
  assert.ok(e.eventsLog.some(x => x.type === 'upgrade_fresh_install'));
});

check('期望 stopped 则不做健康验证', async () => {
  let healthyCalled = false;
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: true, desiredRunning: false,
    waitHealthy: async () => { healthyCalled = true; return { ok: true }; } });
  const r = await upgrade(e, null, {});
  assert.strictEqual(r.result, 'installed');
  assert.strictEqual(healthyCalled, false, 'desired=stopped 不应做健康验证');
});

check('安装后版本不符即失败（不等健康验证）', async () => {
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: false, installSets: { '2.0.0': '1.9.9' } });
  const r = await upgrade(e, null, { upgradeAutoRollback: false });
  assert.strictEqual(r.ok, false);
  assert.ok(/安装后版本校验失败/.test(r.error), '错误应指出版本校验: ' + r.error);
});

check('健康验证失败→自动回滚→报 failed', async () => {
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: true,
    waitHealthy: async () => ({ ok: false, reason: 'timeout' }) });
  const r = await upgrade(e, null, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/已回滚到 1.0.0/.test(r.error), '错误应说明已回滚: ' + r.error);
  // 回滚：装回 1.0.0
  assert.deepStrictEqual(e.calls.installs, ['2.0.0', '1.0.0'], '应先装新版再装回旧版');
  assert.strictEqual(e.state.disk, '1.0.0', '磁盘应回到旧版');
  const types = e.eventsLog.map(x => x.type);
  assert.ok(types.includes('upgrade_failed'));
});

check('回滚关闭时不回滚', async () => {
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: true,
    waitHealthy: async () => ({ ok: false, reason: 'timeout' }) });
  const r = await upgrade(e, null, { upgradeAutoRollback: false });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(e.calls.installs, ['2.0.0'], '不应回滚安装');
  assert.ok(/回滚/.test(r.error) === false || /升级失败/.test(r.error), '错误不应声称已回滚: ' + r.error);
});

check('安装抛异常且磁盘版本已变→回滚', async () => {
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: true });
  // 装到一半抛错，但磁盘已被改成 2.0.0（版本已变 = needsRollback 成立）
  e.install = async (v) => { e.calls.installs.push(v); e.state.disk = '2.0.0'; throw new Error('npm E500'); };
  const r = await upgrade(e, null, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/npm E500/.test(r.error));
  assert.deepStrictEqual(e.calls.installs, ['2.0.0', '1.0.0'], '版本已变应回滚');
  assert.ok(e.eventsLog.some(x => x.type === 'upgrade_rollback_started'));
});

check('安装抛异常但磁盘版本未变→不回滚（无需回滚）', async () => {
  const e = mkEnv({ disk: '1.0.0', latest: '2.0.0', active: true });
  e.install = async (v) => { e.calls.installs.push(v); throw new Error('npm E500'); };
  const r = await upgrade(e, null, {});
  assert.strictEqual(r.ok, false);
  // 原实现语义：needsRollback 要求 current !== oldVersion；磁盘没变就不回滚
  assert.deepStrictEqual(e.calls.installs, ['2.0.0'], '磁盘版本未变不应回滚');
  assert.ok(!e.eventsLog.some(x => x.type === 'upgrade_rollback_started'), '不应触发回滚');
  assert.ok(e.logs.some(l => /磁盘仍是旧版本/.test(l)), '应如实说明无需回滚');
});

check('env 全缺省时不崩（所有 hooks 可选）', async () => {
  const bare = { installedVersion: () => '1.0.0', latestVersion: async () => ({ ok: true, version: '1.0.0' }) };
  const r = await upgrade(bare, null, {});
  assert.strictEqual(r.ok, true, '最小 env 应能跑完 up-to-date 路径: ' + r.error);
  assert.strictEqual(r.result, 'up-to-date');
});

check('指定版本时不查 latest', async () => {
  let queried = false;
  const e = mkEnv({ disk: '1.0.0', latestVersion: async () => { queried = true; return { ok: true, version: '9.9.9' }; } });
  const r = await upgrade(e, '2.5.0', {});
  assert.strictEqual(r.to, '2.5.0', '应装指定版本');
  assert.strictEqual(queried, false, '指定版本不应查 latest');
});

setTimeout(() => {
  console.log('agent ops/upgrade 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
  if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL AGENT UPGRADE TESTS PASS');
}, 800);