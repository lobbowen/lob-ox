#!/usr/bin/env node
'use strict';

// FRP 自愈回归（20复）：
//   R1 配置生成必须含 loginFailExit = false（否则 frps 暂不可达 -> frpc 退出且不重试 -> 隧道永久失效）
//   R2 frpc 非预期退出 -> 有界退避自动重拉（真实子进程 kill 验证）
//   R3 主动 stop / 停用 / 无代理 -> 不重启

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-res-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  //  结构改造：进程托管在 frp.js（原 frpmgr.js）。
  const { FrpManager } = require(path.join(ROOT, 'src', 'domains', 'relay', 'frp'));

  // -- R1：配置健壮性 --
  console.log('== R1 配置健壮性（loginFailExit）==');
  {
    const m = new FrpManager({ dir: TMP, logger, events: null });
    const settings = { serverAddr: '1.2.3.4', serverPort: 7000, authToken: 'tok', user: 'dsh' };
    const insts = [{ id: 'inst-abc12345', remoteMode: 'wan', wanPort: 28070 }];
    const { text, count } = m.buildConfig(settings, insts);
    check('R1-a 生成配置含 loginFailExit = false', /^loginFailExit = false$/m.test(text), 'ok');
    check('R1-b 代理条目正确（公网口与 relay 口恒同号：localPort=remotePort=wanPort）', count === 1 && /localPort = 28070/.test(text) && /remotePort = 28070/.test(text), 'count=' + count);
    check('R1-c/d wanPort 缺失 / 非 wan 实例（lan、无 remoteMode）均不生成无效代理（防 frpc 解析失败）',
      m.buildConfig(settings, [{ id: 'x', remoteMode: 'wan', wanPort: null }]).count === 0
      && m.buildConfig(settings, [{ id: 'y', remoteMode: 'lan', wanPort: 28071 }, { id: 'z', wanPort: 28072 }]).count === 0, 'ok');
  }

  // -- R5：凭据落盘卫生 + API 回显掩码（AUDIT B-6/B-7）--
  console.log('== R5 frp.json 写入卫生 + status() 掩码 ==');
  {
    const D5 = fs.mkdtempSync(path.join(TMP, 'hyg-'));
    const m5 = new FrpManager({ dir: D5, logger, events: null });
    m5.saveSettings({ serverAddr: '1.2.3.4', serverPort: 7000, authToken: 'S3CR3T-frp', user: 'dsh' });
    const raw5 = fs.readFileSync(m5.settingsFile, 'utf8');
    check('R5-a settings 落盘可读（写链路未被掩码改动破坏）', /S3CR3T-frp/.test(raw5), 'ok');
    if (process.platform !== 'win32') {
      const mode5 = fs.statSync(m5.settingsFile).mode & 0o777;
      check('R5-b frp.json 权限 0600（authToken 明文不出属主；旧实现默认 umask 落盘）',
        mode5 === 0o600, 'mode=' + (mode5).toString(8));
    } else console.log('SKIP R5-b（Windows 无 POSIX 权限位）');
    const strays5 = fs.readdirSync(D5).filter((f) => /\.tmp/.test(f));
    check('R5-c 写完成无 .tmp 残留（rename 原子替换）', strays5.length === 0, strays5.join(','));
    const st5 = m5.status();
    check('R5-e status().settings 不回显 authToken 明文，只报 authTokenSet（AUDIT B-7，与 access.js 同规）',
      !('authToken' in st5.settings) && st5.settings.authTokenSet === true && !JSON.stringify(st5).includes('S3CR3T-frp'),
      JSON.stringify(st5.settings));
    check('R5-f 非机密配置字段照常回显（UI 回填面不丢；总闸字段已随三态模型废止）',
      st5.settings.serverAddr === '1.2.3.4' && st5.settings.serverPort === 7000 && st5.settings.enabled === undefined,
      JSON.stringify(st5.settings));
  }

  // -- R2/R3：真实子进程 crash -> 自动重拉 --
  //  仅 POSIX：用 POSIX shell 脚本（#!/bin/sh + sleep）冒充 frpc；Windows 无法执行该格式
  //  （属测试夹具的平台限制，非产品缺陷），跳过并显式说明，不静默变绿。
  console.log('== R2/R3 非预期退出自动重拉 ==');
  if (process.platform === 'win32') {
    console.log('SKIP R2/R3（Windows 无法执行 POSIX shell 夹具）');
  } else {
    const D = fs.mkdtempSync(path.join(TMP, 'live-'));
    const m = new FrpManager({ dir: D, logger, events: { append() {} } });
    // 用真实可执行脚本冒充 frpc：长驻 sleep，便于 kill 模拟崩溃
    fs.mkdirSync(path.dirname(m.binPath), { recursive: true });
    fs.writeFileSync(m.binPath, '#!/bin/sh\nsleep 300\n');
    fs.chmodSync(m.binPath, 0o755);
    m.saveSettings({ serverAddr: '127.0.0.1', serverPort: 7000, authToken: 'tok', user: 'dsh' });
    const insts = [{ id: 'inst-abc12345', remoteMode: 'wan', wanPort: 28070 }];
    m.syncFromInstances(insts);
    await sleep(400);
    const first = m.child;
    check('R2-a 配置就绪且真实启动', !!first && Number.isInteger(first.pid), 'pid=' + (first && first.pid));

    // 非预期退出（外部 kill -9）-> exit 事件 -> 排期重启
    if (first) { try { process.kill(first.pid, 'SIGKILL'); } catch {} }
    await sleep(600);

    // 等退避到期（2s）-> 新进程出现
    await sleep(2600);
    const second = m.child;
    check('R2-d 退避到期后自动重拉（新 pid，非原进程）', !!second && Number.isInteger(second.pid) && (!first || second.pid !== first.pid), 'pid=' + (second && second.pid));

    // 主动 stop -> 清定时器、不重启
    m.stop();
    await sleep(300);
    check('R3-a 主动 stop 后无子进程且不再 spawn', m.child === null, 'ok');

    // 无代理（无 wan 隧道）-> 即使退出也不重启（frpc 生命周期单一条件 = 是否存在 wan 隧道）
    m.syncFromInstances([]);
    await sleep(2600);
    check('R3-c 停用/无代理时不重启', m.child === null, 'child=' + (m.child && m.child.pid));
    try { if (m.child && m.child.pid) process.kill(m.child.pid, 'SIGKILL'); } catch {}
  }

  // -- R4：frpc 不可执行时必须优雅降级（不得抛出 / 不得崩溃进程）--
  //   两条失败路径都要覆盖：
  //     1) spawn 同步抛出（Windows 上拿非可执行格式当程序）
  //     2) spawn 异步 emit 'error'（存在但不可执行：权限/架构/目标是目录）
  //   2)若无监听器会成为未捕获异常 -> 整个守卫崩溃。
  console.log('== R4 frpc 不可执行时的降级 ==');
  {
    const D4 = fs.mkdtempSync(path.join(TMP, 'bad-'));
    const m4 = new FrpManager({ dir: D4, logger, events: { append() {} } });
    fs.mkdirSync(m4.binPath, { recursive: true });   // binPath 变成**目录**：existsSync 通过但不可执行
    m4.saveSettings({ serverAddr: '127.0.0.1', serverPort: 7000, authToken: 'tok', user: 'dsh' });
    m4.syncFromInstances([{ id: 'inst-abc12345', remoteMode: 'wan', wanPort: 28070 }]);
    // 原 R4-a（`check(…, true, 'ok')` 恒真断言）已删：「不同步抛」由本行覆盖——真抛则落 L131 .catch 非零退出。
    await sleep(500);
    check('R4-b 异步 spawn 失败已被处理（child 清空、进程未崩溃）', m4.child === null, 'child=' + (m4.child && m4.child.pid));
    m4.stop();
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });