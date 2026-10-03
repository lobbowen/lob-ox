#!/usr/bin/env node
'use strict';

// H-02 受管实例存活判据：端口上有人听 ≠ 本实例在跑。
// 判据必须同时答两件事，且两件事分别有读者：
//   portTaken = 端口上有监听者（无论它是谁）→ 只喂启动前占用守卫（lifecycle.js start）
//   running   = 监听者 cmdline 像 DSH         → 喂相位迁移 / 资源采样 / 重启决策
// 身份读不到（cmdline 为 null）⇒ running:false + identityUnknown:true：宁判「没在跑」，不判「在跑」。
//
// 注入缝：pidlookup 整体替换（findListeningPid / readCmdline），不碰真实进程表 ⇒ 四平台可跑、无宿主依赖。
// ⚠️ 注入必须在 require 实例域**之前**完成：lifecycle.js 在模块加载时就抓住 monitor 的引用，
//   事后换 require.cache 换不到它手上那份（曾因此拿到假绿：两条断言都按真 pidlookup 跑，结论同形）。
// 写本文件时正则里别出现反斜杠括号（字符串转义会吃掉反斜杠、把转义变成捕获组，判据失真），用 includes/indexOf。

const path = require('node:path');
const fsx = require('node:fs');
const osx = require('node:os');
const ROOT = path.join(__dirname, '..');
const PL = path.join(ROOT, 'src', 'platform', 'os', 'pidlookup', 'index.js');
const MON = path.join(ROOT, 'src', 'platform', 'service', 'monitor.js');
const DOMAIN = path.join(ROOT, 'src', 'domains', 'instance', 'index.js');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

// ── 注入：先取真实身份判据（要测的就是它），再用同一份函数装配桩 ──────────────────
const realPidlookup = require(PL);
const realIsDshCmdlineText = realPidlookup.isDshCmdlineText;
check('S-0 前提：pidlookup 导出单源身份判据 isDshCmdlineText（monitor 不再自抄一份 /dsh/i）',
  typeof realIsDshCmdlineText === 'function', typeof realIsDshCmdlineText);

const wire = { port: 0, pid: null, cmd: null }; // 桩的可变输入：端口 / 监听者 pid / 该 pid 的 cmdline
const stub = {
  findListeningPid: (port) => (port === wire.port ? wire.pid : null),
  readCmdline: (pid) => (pid !== null && pid === wire.pid ? wire.cmd : null),
  isDshCmdlineText: (cmd) => realIsDshCmdlineText(cmd),
  isDshCmdline: (pid) => realIsDshCmdlineText(stub.readCmdline(pid)),
  isAlive: () => true,
};
require.cache[PL] = { id: PL, filename: PL, loaded: true, exports: stub };
delete require.cache[MON];

const PORT = 28400; // 安全段内、_ports.js 全部已登记段之外（28000+27*10-1=28269 以内）⇒ 不撞号
const DSH_CMD = 'node /opt/inst/install/node_modules/@deepseek-ai/dsh/lib/bin.js web --port ' + PORT;
const FOREIGN_CMD = 'python -m http.server ' + PORT;

const mon = require(MON);
const at = (pid, cmd) => { wire.port = PORT; wire.pid = pid; wire.cmd = cmd; };

// L-1 端口空着：两件事都否（既没被占，也没在跑）
at(null, null);
{
  const st = mon.probeInstance({ port: PORT });
  check('L-1 端口空着 ⇒ running=false 且 portTaken=false（不是「有人听」，也不是「在跑」）',
    st.running === false && st.portTaken === false && st.pid === null && st.identityUnknown === false,
    JSON.stringify(st));
}

// L-2 H-02 的核心缺陷形态：外来进程蹲在端口上 ⇒ portTaken=true 但 running=false
at(4242, FOREIGN_CMD);
{
  const st = mon.probeInstance({ port: PORT });
  check('L-2 外来进程占端口（cmdline 无 dsh）⇒ portTaken=true 但 running=false（旧实现会判 running=true）',
    st.portTaken === true && st.running === false && st.pid === 4242 && st.identityUnknown === false,
    JSON.stringify(st));
}

// L-3 本实例在跑：两件事都真
at(4242, DSH_CMD);
{
  const st = mon.probeInstance({ port: PORT });
  check('L-3 本实例在跑（cmdline 含 dsh）⇒ running=true 且 portTaken=true，phase=RUNNING',
    st.running === true && st.portTaken === true && st.isDsh === true && st.phase === 'RUNNING',
    JSON.stringify(st));
}

// L-4 身份读不到：宁可 running=false + portTaken=true + identityUnknown=true
at(4242, null);
{
  const st = mon.probeInstance({ port: PORT });
  check('L-4 cmdline 读不到 ⇒ running=false + portTaken=true + identityUnknown=true（身份未知不冒充存活）',
    st.running === false && st.portTaken === true && st.identityUnknown === true && st.isDsh === false,
    JSON.stringify(st));
}

// L-5 非法端口不得谎报：与「端口空着」同形，绝不落到 running=true
at(4242, DSH_CMD);
{
  const bads = [0, -1, 1.5, null, undefined, '3080'];
  let ok = true;
  for (const bad of bads) {
    const st = mon.probeInstance({ port: bad });
    if (st.running !== false || st.portTaken !== false) { ok = false; console.log('   bad ' + JSON.stringify(bad) + ' -> ' + JSON.stringify(st)); }
  }
  const stNone = mon.probeInstance({});
  check('L-5 端口缺失/非法（0 / 负 / 小数 / null / 字符串 / 无字段）一律 running=false + portTaken=false',
    ok && stNone.running === false && stNone.portTaken === false, JSON.stringify(stNone));
}

// L-6 身份判据沿用既有 effective 语义 /dsh/i（O-03：只显式化，不引入新语义）
{
  const cases = [
    ['/opt/inst/node_modules/@deepseek-ai/dsh/lib/bin.js web', true],
    ['NODE /opt/inst/node_modules/@deepseek-ai/DSH/lib/bin.js web', true],
    ['python -m http.server', false],
    ['', false],
    [null, false],
  ];
  let ok = true;
  for (const c of cases) {
    const got = realIsDshCmdlineText(c[0]);
    if (got !== c[1]) { ok = false; console.log('   ' + JSON.stringify(c[0]) + ' got=' + got + ' want=' + c[1]); }
  }
  check('L-6 身份判据仍为 /dsh/i（大小写不敏；空 / null 判否）—— 未引入新语义', ok, 'ok');
}

// L-7 身份证据真的有读者：running 的判据里必须出现 isDsh（否则又是写而不读）
{
  const src = fsx.readFileSync(MON, 'utf8');
  const line = src.split(/\n/).find((l) => l.indexOf('const running = ') >= 0) || '(未找到)';
  check('L-7 running 的判据引用身份证据 isDsh（身份自此有读者，不再是写而不读）',
    line.indexOf('isDsh') >= 0 && line.indexOf('portTaken') >= 0 && line.indexOf('cmdlineKnown') >= 0, line.trim());
}

// ── L-8..L-10：真实消费点的行为后果（H-02 的真正代价）───────────────────────────
// 不是字段面，是「守卫因此不重启 / 按外来 pid 采样」。用可注入假 service 跑一次 supervise / start。
// 实例域在此处 require：它加载时抓住的是上面已注入的 monitor（注入顺序 = 本测试的生命线，见文件头注）。
const { InstanceManager } = require(DOMAIN);

function mkScenario() {
  const tmp = fsx.mkdtempSync(path.join(osx.tmpdir(), 'lobox-w0b-'));
  const svcCalls = [];
  const mgr = new InstanceManager({
    dir: tmp, logger: { info() {}, warn() {}, error() {} },
    service: {
      daemonReload() { return true; }, stopUnit() { svcCalls.push('stopUnit'); return true; }, resetFailed() { return true; },
      isUnitActive() { return false; }, transientUnitFile() { return null; }, cleanTransient() {},
      startTransient() { svcCalls.push('startTransient'); return true; }, setLimits() { return false; },
    },
    tasks: { isBusy: () => false, current: () => null, list: () => [] },
    resstats: { sampleAsync: () => Promise.resolve(null) },
    machineFacts: () => ({ totalMemBytes: 16 * 1024 * 1024 * 1024, cpuCount: 8 }),
  });
  mgr._setSandboxSupportedForTest(true);
  mgr._ctx.install = async () => ({ ok: false, error: '桩：绝不真实安装' });
  const mkInst = (phase) => ({
    id: 'w0b', name: 'W0B', domain: 'sandbox', port: PORT, guardian: true,
    state: { phase, restartCount: 0, startupFailWindowStart: null, startupFailCount: 0, restartAt: null, startAt: Date.now() - 60000, allocation: null },
  });
  return { mgr, mkInst, svcCalls, tmp };
}

(async () => {
  // L-8 外来进程占端口 ⇒ 相位必须从 RUNNING 掉下来（旧实现：running=true ⇒ 相位不动、守卫永不重启）
  {
    const { mgr, mkInst, tmp } = mkScenario();
    const inst = mkInst('RUNNING');
    mgr.instances = [inst];
    at(4242, FOREIGN_CMD);
    mgr.supervise('w0b');
    check('L-8 外来进程占端口 ⇒ supervise 判实例已退出（相位离开 RUNNING，守卫才会重启）',
      inst.state.phase !== 'RUNNING', inst.state.phase);
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }

  // L-9 反向：本实例在跑 ⇒ 相位维持 RUNNING，且不得误触发重启（不误杀健康实例）
  {
    const { mgr, mkInst, svcCalls, tmp } = mkScenario();
    const inst = mkInst('RUNNING');
    mgr.instances = [inst];
    at(4242, DSH_CMD);
    mgr.supervise('w0b');
    check('L-9 反向：本实例在跑 ⇒ 相位维持 RUNNING 且零拉起（不误杀健康实例）',
      inst.state.phase === 'RUNNING' && svcCalls.length === 0, inst.state.phase + ' ' + svcCalls.join(','));
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }

  // L-10 启动前占用守卫：外来进程占端口时 start 必须显式拒绝（占了就是占了，与身份无关）
  {
    const { mgr, mkInst, svcCalls, tmp } = mkScenario();
    const inst = mkInst('STOPPED');
    mgr.instances = [inst];
    const dshEntry = require(path.join(ROOT, 'src', 'domains', 'instance', 'sandbox.js')).dshEntry(mgr.instancesRoot, inst);
    fsx.mkdirSync(path.dirname(dshEntry), { recursive: true });
    fsx.writeFileSync(dshEntry, '// stub entry');
    at(4242, FOREIGN_CMD);
    const r = await mgr.startInstance('w0b', { fromUpgrade: true });
    check('L-10 启动前守卫按 portTaken 拒（外来进程占端口 ⇒ 显式拒绝，不下发启动）',
      !!r && r.ok === false && String(r.error).indexOf('已被占用') >= 0 && svcCalls.length === 0,
      JSON.stringify(r) + ' calls=' + svcCalls.join(','));
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }
})().catch((e) => {
  check('L-8..L-10 无异常', false, (e && e.message) || String(e));
}).then(() => {
  // 收尾挂在异步链尾：模块末尾的同步 process.exit 会先跑，把 async 块的断言整段掐掉（假绿）。
  process.exit(results.every(Boolean) ? 0 : 1);
});
