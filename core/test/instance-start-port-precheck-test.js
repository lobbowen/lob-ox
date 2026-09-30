#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 实例启动预校验：配置端口**被他进程登记**时必须显式拒绝，不得拖到 systemd bind
//
// 缺陷（被测对象：InstanceManager.startInstance 的端口预校验）：静默端口（登记了但没有监听者）
//   TCP 探测不可见，旧行为放任到 systemd 起舱后才以 bind 失败暴露，面板无从定位。注册表是
//   **跨进程共享事实源**，判据只在册不在听。
//
// 锁定不变量：P-a 端口被他方登记 -> 立即 PORT_TAKEN:<by> 显式拒绝（不下发启动）· P-b 反向：
//   自有登记（syncPorts 的 inst:<id> 形态）不误判，正常走到下发 · P-c 拒绝原因写入实例
//   state.lastError（失败可追，不再是静默无痕）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-port-'));

(async () => {
  const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
  const ports = require(path.join(ROOT, 'src', 'platform', 'service', 'ports')).shared;
  ports.configureFile(path.join(TMP, 'r13-ports.json')); // 本测试进程的注册表指到独立文件，绝不触真实状态根
  const GiB = (n) => n * 1024 * 1024 * 1024;
  const P4 = 28320; // 安全段内、_ports 已登记段之外（防撞号）
  let started = 0;
  const fakeService = {
    daemonReload() { return true; }, stopUnit() { return true; }, resetFailed() { return true; },
    isUnitActive() { return false; }, transientUnitFile() { return null; }, cleanTransient() {},
    startTransient() { started++; return true; },
  };
  const mgr = new InstanceManager({
    dir: path.join(TMP, 'sup4'), logger: { info() {}, warn() {}, error() {} },
    tasks: { isBusy: () => false }, service: fakeService,
    machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
  });
  mgr._setSandboxSupportedForTest(true);
  mgr.instances = [{ id: 'b25', name: 'x', domain: 'native', port: P4, state: { phase: 'STOPPED' } }];

  ports.allocateMark(P4, 'relay', 'relay:thief'); // lan-daemon 侧已把该端口登记给 relay（无监听）
  const r4a = await mgr.startInstance('b25');
  check('P-a 端口被他方登记 -> 立即 PORT_TAKEN:<by> 显式拒绝（不等 systemd bind 失败、不下发启动），且原因写入 state.lastError',
    r4a && r4a.ok === false && r4a.error === 'PORT_TAKEN:relay:thief' && started === 0
    && /PORT_TAKEN/.test(mgr.instances[0].state.lastError || ''),
    JSON.stringify(r4a) + ' started=' + started + ' lastError=' + String(mgr.instances[0].state.lastError));

  // 反向（判据不误伤）：自有登记（syncPorts 的 inst:<id> 形态）照常放行
  ports.release(P4);
  ports.registerUser(P4, 'inst:b25');
  const r4b = await mgr.startInstance('b25');
  check('P-b 反向：自有 inst:<id> 登记不误判，正常走到下发', r4b && r4b.ok === true && started === 1,
    JSON.stringify(r4b) + ' started=' + started);

  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.error('ERR', e);
  process.exit(1);
});
