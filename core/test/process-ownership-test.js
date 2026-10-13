'use strict';

// 进程所有权接线测试：沙箱实例必须出现在壳的进程表里。
//
// 此前裂缝：壳的 ProcessManager 只登记内核自己；沙箱实例走 systemd 自拉，
// 全仓无 managedObjects.register() 调用——沙箱实例从不在任何进程表里。
// 后果：壳 heal 看不到它、停机不知道停它。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

let pass = 0;
const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

const CORE = 'C:/work/lob-ox/core/src';
const SHELL = 'C:/work/lob-ox/shell/src-tauri/src';

check('pm-client 路由与壳侧 mgmt 一致（无死路由）', () => {
  const pmc = fs.readFileSync(CORE + '/platform/contract/pm-client.js', 'utf8');
  const called = [...pmc.matchAll(/post'\((\/pm\/[a-z-]+)'/g)].map((m) => m[1]);
  const mgmt = fs.readFileSync(SHELL + '/process_manager/mgmt.rs', 'utf8');
  const routes = [...mgmt.matchAll(/\("POST", "(\/pm\/[a-z-]+)"\)/g)].map((m) => m[1]);
  const dead = called.filter((r) => !routes.includes(r));
  assert.strictEqual(dead.length, 0, 'pm-client 调用了壳不支持的路由: ' + dead.join(','));
});

check('lifecycle import pm-client', () => {
  const lc = fs.readFileSync(CORE + '/domains/instance/lifecycle.js', 'utf8');
  assert.ok(/platform\/contract\/pm-client/.test(lc), 'lifecycle.js 应 import pm-client');
});

check('启动路径 register 带真实 spawn_cmd', () => {
  const lc = fs.readFileSync(CORE + '/domains/instance/lifecycle.js', 'utf8');
  assert.ok(/pmClient\.register\(\{[\s\S]{0,240}spawn_cmd:\s*cmdArr/.test(lc),
    'register 必须带 spawn_cmd: cmdArr');
  assert.ok(/pmClient\.setDesired\([^)]*running/.test(lc), 'register 后必须 setDesired running');
});

check('四个相位点都同步给壳', () => {
  const lc = fs.readFileSync(CORE + '/domains/instance/lifecycle.js', 'utf8');
  const n1 = (lc.match(/pmClient\.register\(/g) || []).length;
  const n2 = (lc.match(/pmClient\.setDesired\(/g) || []).length;
  const n3 = (lc.match(/pmClient\.onPhase\(/g) || []).length;
  assert.strictEqual(n1, 1, '应有 1 处 register，实际 ' + n1);
  assert.strictEqual(n2, 2, '应有 2 处 setDesired（running/stopped），实际 ' + n2);
  assert.strictEqual(n3, 2, '应有 2 处 onPhase（stopped/supervise），实际 ' + n3);
});

check('supervise 每拍同步相位（壳 heal 的判据来源）', () => {
  const lc = fs.readFileSync(CORE + '/domains/instance/lifecycle.js', 'utf8');
  const s = lc.indexOf('function supervise(id)');
  assert.ok(s > 0, '应有 supervise 函数');
  assert.ok(/pmClient\.onPhase/.test(lc.slice(s, s + 700)), 'supervise 必须上报相位');
});

check('壳 spawn_healer 对空 spawn_cmd 跳过', () => {
  const pm = fs.readFileSync(SHELL + '/process_manager/mod.rs', 'utf8');
  assert.ok(/is_empty\(\)/.test(pm) && /continue/.test(pm),
    '壳 heal 跳过空 spawn_cmd——这正是必须传 cmdArr 的原因');
});

check('壳 heal_candidates 只捞 desired=running 且 phase=failed', () => {
  const pm = fs.readFileSync(SHELL + '/process_manager/mod.rs', 'utf8');
  assert.ok(/Desired::Running/.test(pm) && /Phase::Failed/.test(pm),
    '壳 heal 判据应是 desired=running + phase=failed');
});

check('Sandbox 优先级在壳侧已定义', () => {
  const sm = fs.readFileSync(SHELL + '/process_manager/state_machine.rs', 'utf8');
  assert.ok(/Sandbox = 3/.test(sm), 'state_machine 应定义 Sandbox 优先级');
});

check('沙箱注册必须传 env（否则 heal 重拉写真实用户目录）', () => {
  const lc = fs.readFileSync(CORE + '/domains/instance/lifecycle.js', 'utf8');
  // register 调用必须含 env 字段
  assert.ok(/pmClient\.register\(\{[\s\S]{0,300}?\benv,\s*\n\s*\}\);/.test(lc),
    'pmClient.register 必须传 env');
  // 且 env 必须来自 sandboxEnv（不能是空对象或 process.env）
  const s = lc.indexOf('pmClient.register({');
  const block = lc.slice(s, s + 400);
  assert.ok(/env,\s*\n/.test(block), 'env 应为简写形式（来自上方 sandboxEnv 解构）');
  assert.ok(/const \{ env, workingDir \} = sandbox\.sandboxEnv/.test(lc),
    'env 必须来自 sandbox.sandboxEnv 的解构');
});

check('壳侧 WorkloadDesc 有 env 字段', () => {
  const sm = fs.readFileSync(SHELL + '/process_manager/state_machine.rs', 'utf8');
  assert.ok(/pub env: Vec<\(String, String\)>/.test(sm),
    'WorkloadDesc 应有 env: Vec<(String, String)> 字段');
  // WorkloadState 也要有（heal_candidates 从 state 重建 desc）
  assert.ok(/pub struct WorkloadState[\s\S]{0,900}pub env: Vec<\(String, String\)>/.test(sm),
    'WorkloadState 应有 env 字段，否则 heal_candidates 重建 desc 时丢失');
});

check('壳侧 spawn_healer 应用 env 覆盖', () => {
  const pm = fs.readFileSync(SHELL + '/process_manager/mod.rs', 'utf8');
  const h = pm.indexOf('pub fn spawn_healer');
  const body = pm.slice(h, h + 1400);
  assert.ok(/for \(k, v\) in &desc\.env/.test(body),
    'spawn_healer 必须应用 desc.env，否则 heal 重拉的沙箱实例写真实用户目录');
  assert.ok(/cmd\.env\(k, v\)/.test(body), '应有 cmd.env(k, v) 调用');
});

check('壳侧 parse_desc 读 env（JSON 对象 → Vec）', () => {
  const mg = fs.readFileSync(SHELL + '/process_manager/mgmt.rs', 'utf8');
  const s = mg.indexOf('fn parse_desc');
  const body = mg.slice(s, s + 1200);
  assert.ok(/get\("env"\)/.test(body), 'parse_desc 应读 env 字段');
  assert.ok(/as_object\(\)/.test(body), 'env 应按 JSON 对象解析');
  assert.ok(/pairs\.sort_by/.test(body), 'env 应排序（顺序稳定便于对账）');
});

check('壳侧 heal_candidates 重建 desc 时带 env', () => {
  const pm = fs.readFileSync(SHELL + '/process_manager/mod.rs', 'utf8');
  const h = pm.indexOf('pub fn heal_candidates');
  const body = pm.slice(h, h + 900);
  assert.ok(/env: st\.env\.clone\(\)/.test(body),
    'heal_candidates 重建 WorkloadDesc 必须带 env，否则 spawn_healer 拿不到');
});

check('壳侧 adopt_spawned 存 env', () => {
  const pm = fs.readFileSync(SHELL + '/process_manager/mod.rs', 'utf8');
  const h = pm.indexOf('pub fn adopt_spawned');
  const body = pm.slice(h, h + 700);
  assert.ok(/st\.env = desc\.env\.clone\(\)/.test(body), 'adopt_spawned 应存 env');
});

check('壳侧 core_desc 有 env 字段（原生负载空 env）', () => {
  const g = fs.readFileSync(SHELL + '/domain/guardctl.rs', 'utf8');
  const s = g.indexOf('fn core_desc');
  const body = g.slice(s, s + 400);
  assert.ok(/env: Vec::new\(\)/.test(body), 'core_desc 应有 env: Vec::new()');
});

check('sandboxEnv 覆盖度（11 个变量，含 Windows 专有）', () => {
  const se = fs.readFileSync(CORE + '/domains/agent/runtime/sandbox-env.js', 'utf8');
  const need = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'TMPDIR', 'npm_config_cache', 'npm_config_userconfig'];
  const missing = need.filter((k) => !new RegExp('env\\.' + k + '\\s*=').test(se));
  assert.strictEqual(missing.length, 0, 'sandbox-env 缺变量: ' + missing.join(','));
});
check('pm-client 端到端不抛（无契约文件时静默）', () => {
  const pmc = require(CORE + '/platform/contract/pm-client.js');
  const ep = pmc.endpoint();
  const ok = ep === null || (typeof ep.port === 'number' && typeof ep.token === 'string');
  assert.ok(ok, 'endpoint 应返回 null 或合法端点');
  const r = pmc.register({ id: 'test:probe', spawn_cmd: [], priority: 3 });
  assert.strictEqual(typeof r, 'boolean', 'register 应返回 boolean');
});

console.log('进程所有权接线测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) { console.log(fails.map((f) => '  x ' + f).join(String.fromCharCode(10))); process.exit(1); }
console.log('ALL PROCESS-OWNERSHIP WIRING TESTS PASS');