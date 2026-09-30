#!/usr/bin/env node
'use strict';

// lan-daemon（L3b 进程解耦）机制集成测试：
//  - lan-daemon 从 lan-state.json 快照拉起 relay（mock 目标）：wanPort 绑定唯一权威是端口注册表
//    （与守卫共写 ports.json 单本账，claimSlot byOwner），实例行不带端口字段 —— 测试经 ctl list
//    回读实际绑定端口，不硬编码期望值。
//  - ctl list/frpStatus/health 可用；状态 diff（行缺席/remoteMode=off -> 移除 relay，新增 -> 补建）；
//    SIGTERM 优雅退出（端口释放）。自包含：mock HTTP 目标 + 独立 tmp config/lan-state。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { safePort } = require(path.join(__dirname, '_ports.js'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-daemon-test-'));
const TARGET_A = safePort('lan-daemon', 0);
const TARGET_B = safePort('lan-daemon', 1);
// wanPort 不再硬编码：绑定权威是 daemon 侧端口注册表，实际端口经 ctl list 回读（portA/portB）。
const CTL = safePort('lan-daemon', 5); // 避开段内 28104 默认位，防与未来生产冲突（config.lanCtlPort 覆盖）

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startTarget(port, tag) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('mock-' + tag + ' ' + req.url);
  });
  return new Promise((resolve) => s.listen(port, '127.0.0.1', () => resolve(s)));
}
function portListening(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/probe' }, (res) => { res.resume(); res.on('end', () => resolve(true)); });
    r.on('error', () => resolve(false));
    r.setTimeout(400, () => { r.destroy(); resolve(false); });
  });
}
function ctlCall(method, payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port: CTL, path: '/ctl', method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('ctl timeout')); });
    req.end(body);
  });
}

async function main() {
  // -- 环境准备：config（自生成最小配置 + 平台默认值兜底，测试隔离）--
  //  本测试的 config.json 给 **lan-daemon 进程**读，按 buildDefaults(域注入) 取完整默认值与生产模板同形。
  let realCfg = {};
  try { realCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'supervisor', 'config.json'), 'utf8')); } catch {}
  const { buildDefaults } = require('../src/platform/service/config');
  const { extension } = require('../src/app/settings/domain-config');
  const cfg = Object.assign(buildDefaults(extension()), realCfg, {
    command: ['node', path.join(__dirname, 'mock-target.js'), String(TARGET_A)],
    healthUrl: 'http://127.0.0.1:' + TARGET_A + '/',
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    logLevel: 'info',
    lanCtlPort: CTL,
    lanDaemon: true,
  });
  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const lanState = path.join(TMP, 'lan-state.json');
  const writeState = (doc) => fs.writeFileSync(lanState, JSON.stringify(doc, null, 1));

  const ta = await startTarget(TARGET_A, 'A');
  const tb = await startTarget(TARGET_B, 'B');
  const makeInst = (id, port) => ({ id, name: id, port, remoteMode: 'lan', remoteToken: '' });

  writeState({ updatedAt: Date.now(), instances: [makeInst('it-a', TARGET_A), makeInst('it-b', TARGET_B)], tokens: {} });

  // -- 启动 lan-daemon --
  // 诊断：stdio 由 ignore 改为捕获 stderr——wanPort 未监听失败时打印 daemon 错误（Windows 平台调试）。
  const daemonErr = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'domains', 'relay', 'daemon.js'), '-c', cfgPath], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  child.stderr.on('data', (c) => { daemonErr.push(c.toString()); if (daemonErr.length > 200) daemonErr.shift(); });
  child.unref();
  let ctlUp = false;
  for (let i = 0; i < 40; i++) {
    try { await ctlCall('GET', {}); } catch { await sleep(250); continue; }
    // /health
    await sleep(250);
    ctlUp = true;
    break;
  }
  check('lan-daemon 启动且 ctl 可达', ctlUp);
  if (!ctlUp) { child.kill('SIGTERM'); ta.close(); tb.close(); console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); }

  // -- relay 拉起（注册表槽位绑定 + 真实代理）--
  //  wanPort 权威在 daemon 侧端口注册表 -> 期望值只能从 ctl list 回读，再验证「回读端口确实在监听
  //  且确实代理到本目标」。Windows 实测 relay 绑定需 10-14s，窗口放宽到 30s。
  const listOnce = async () => {
    try {
      const l = await ctlCall('POST', { method: 'list', args: [] });
      return (l.value && l.value.items) || [];
    } catch { return []; }
  };
  const rowOf = (its, id) => its.find((x) => x.id === id) || null;
  // 经 relay 口探一次真实代理：只有转发到正确 mock（响应体前缀核对）才算 200——防两口互串误判。
  const proxyTo = (wan, tag) => new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: wan, path: '/probe' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(res.statusCode === 200 && b.startsWith(tag) ? 200 : 0));
    });
    r.on('error', () => resolve(0));
    r.setTimeout(1000, () => { r.destroy(); resolve(0); });
  });
  const waitForBinding = async (id, tag, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      const row = rowOf(await listOnce(), id);
      const wan = row && row.wanPort;
      if (Number.isInteger(wan) && await portListening(wan)) {
        if (await proxyTo(wan, tag) === 200) return wan;
      }
      await sleep(250);
    }
    return null;
  };
  const PORT_A = await waitForBinding('it-a', 'mock-A');
  const PORT_B = await waitForBinding('it-b', 'mock-B');
  check('relay 槽位端口已监听且代理到各自目标（A/B）', PORT_A && PORT_B, { PORT_A, PORT_B });
  if (!(PORT_A && PORT_B)) {
    console.log('--- daemon stderr ---');
    console.log(daemonErr.slice(-80).join(''));
    try { const lf = fs.readFileSync(path.join(TMP, 'sup.log'), 'utf8').split('\n').slice(-40).join('\n'); console.log('--- sup.log tail ---\n' + lf); } catch {}
  }

  const proxy = () => new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT_A, path: '/hi' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    r.on('error', () => resolve({ code: 0, body: '' }));
    r.setTimeout(5000, () => { r.destroy(); resolve({ code: 0, body: 'timeout' }); });
  });

  // -- ctl list --
  const items = await listOnce();
  check('ctl list 含 it-a/it-b 且端口与实测一致',
    rowOf(items, 'it-a') && rowOf(items, 'it-a').wanPort === PORT_A
      && rowOf(items, 'it-b') && rowOf(items, 'it-b').wanPort === PORT_B, JSON.stringify(items));

  // -- 状态 diff：关闭 it-b 远程 -> reconcile 移除；令牌注入不崩 --
  writeState({ updatedAt: Date.now(), instances: [makeInst('it-a', TARGET_A), Object.assign(makeInst('it-b', TARGET_B), { remoteMode: 'off' })], tokens: { 'it-a': 'tok-XYZ' } });
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (!(await portListening(PORT_B))) { gone = true; break; }
  }
  check('remoteMode=off → relay 移除（该槽位端口释放）', gone, { PORT_B });
  // 令牌注入后 A relay 仍代理：daemon 每 2s tick reconcile，it-b 移除可能触发 it-a relay 短暂重建，
  //   轮询等待代理恢复（<=6s），容忍重建窗口。
  let tokProxyOk = false;
  for (let i = 0; i < 20; i++) {
    if ((await proxy()).code === 200) { tokProxyOk = true; break; }
    await sleep(300);
  }
  check('令牌注入后 A relay 仍代理', tokProxyOk);

  // -- 优雅退出 --
  child.kill('SIGTERM');
  await sleep(800);
  // 原「SIGTERM 后进程退出」断言为 `child.exitCode !== null || true` —— `|| true` 使其**恒真、永不可能红**
  //   （作者同行注释自认「detached/unref：用端口判断」），已删；真正的退出证据是紧随其后的端口释放断言。
  const aDown = !(await portListening(PORT_A));
  check('退出后 wanPort 释放', aDown, { PORT_A });

  ta.close(); tb.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
