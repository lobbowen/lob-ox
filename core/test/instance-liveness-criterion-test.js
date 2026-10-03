#!/usr/bin/env node
'use strict';

// H-02 受管实例存活判据：端口上有人听 ≠ 本实例在跑。
//   portTaken = 端口上有监听者（无论它是谁）→ 只喂启动前占用守卫（lifecycle.js start）
//   running   = 监听者身份匹配                → 喂相位迁移 / 资源采样 / 重启决策
//
// 身份判据 = 实例自己的启动锚点（启动命令入口 + `--port <port>`），**不是**产品名：
//   * 入口允许 dsh / dsh.js / lobox / lobox.js ⇒ 按 /dsh/i 判会把合法 lobox 实例判死（守卫重启循环）；
//   * 只含 dsh 字样的无关进程（/opt/dsh-tools/x.js）也不会被锚点认成实例 ⇒ 两头都干净。
// 这是 CI 教回来的一课：严格 /dsh/i 版本在本机 win32 碰巧绿（node 路径含 dsh-supervisor），Linux CI 红。
//
// 注入缝：pidlookup 整体替换，不碰真实进程表 ⇒ 四平台可跑、无宿主依赖。
// ⚠️ 注入必须在 require 实例域**之前**完成：lifecycle.js 在模块加载时就抓住 monitor 的引用，
//   事后换 require.cache 换不到它手上那份（曾因此拿到假绿）。

const path = require('node:path');
const fsx = require('node:fs');
const osx = require('node:os');
const ROOT = path.join(__dirname, '..');
const PL = path.join(ROOT, 'src', 'platform', 'os', 'pidlookup', 'index.js');
const MON = path.join(ROOT, 'src', 'platform', 'service', 'monitor.js');
const DOMAIN = path.join(ROOT, 'src', 'domains', 'instance', 'index.js');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const realPidlookup = require(PL);
const realIsDshCmdlineText = realPidlookup.isDshCmdlineText;
check('S-0 前提：pidlookup 导出单源身份判据 isDshCmdlineText', typeof realIsDshCmdlineText === 'function', typeof realIsDshCmdlineText);

const wire = { port: 0, pid: null, cmd: null };
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
const ENTRY = '/opt/inst/install/node_modules/@deepseek-ai/dsh/lib/bin.js';
const OURS = 'node ' + ENTRY + ' web --port ' + PORT + ' --host 127.0.0.1 --no-open';
const FOREIGN = 'python -m http.server ' + PORT;
const ANCHORS = [ENTRY, '--port ' + PORT]; // 与 sandbox.launchCtx 同源

const mon = require(MON);
const at = (pid, cmd) => { wire.port = PORT; wire.pid = pid; wire.cmd = cmd; };

// L-1 端口空着：两件事都否
at(null, null);
{
  const st = mon.probeInstance({ port: PORT }, { anchors: ANCHORS });
  check('L-1 端口空着 ⇒ running=false 且 portTaken=false',
    st.running === false && st.portTaken === false && st.pid === null, JSON.stringify(st));
}

// L-2 本实例在跑（cmdline 命中自己的锚点）：两件事都真
at(4242, OURS);
{
  const st = mon.probeInstance({ port: PORT }, { anchors: ANCHORS });
  check('L-2 本实例在跑（cmdline 命中启动锚点）⇒ running=true 且 portTaken=true，phase=RUNNING',
    st.running === true && st.portTaken === true && st.phase === 'RUNNING', JSON.stringify(st));
}

// L-3 H-02 核心：外来进程蹲在端口上 ⇒ portTaken=true 但 running=false（旧实现会误判 running=true）
at(4242, FOREIGN);
{
  const st = mon.probeInstance({ port: PORT }, { anchors: ANCHORS });
  check('L-3 外来进程占端口（不命中锚点）⇒ portTaken=true 但 running=false（旧实现会判 running=true）',
    st.portTaken === true && st.running === false && st.pid === 4242, JSON.stringify(st));
}

// L-4 只含 dsh 字样但非本实例的进程（/opt/dsh-tools 类）：不得被认成实例
at(4242, 'node /opt/dsh-tools/build-cache.js --port ' + PORT);
{
  const st = mon.probeInstance({ port: PORT }, { anchors: ANCHORS });
  check('L-4 只含 dsh 字样、不命中锚点 ⇒ running=false（产品名不是身份判据）',
    st.running === false && st.portTaken === true, JSON.stringify(st));
}

// L-5 lobox 入口（合法入口但不含 dsh 字样）：按产品名判会误杀 ⇒ 锚点必须认它
at(4242, 'node /opt/inst/lobox.js web --port ' + PORT + ' --no-open');
{
  const anchors = ['/opt/inst/lobox.js', '--port ' + PORT];
  const st = mon.probeInstance({ port: PORT }, { anchors });
  const byName = realIsDshCmdlineText('node /opt/inst/lobox.js web --port ' + PORT);
  check('L-5 lobox 入口（cmdline 无 dsh 字样）⇒ 锚点判 running=true（按产品名判会误杀 ⇒ 这正是要用锚点的理由）',
    st.running === true && byName === false, 'running=' + st.running + ' byName=' + byName);
}

// L-6 无锚点 + cmdline 可读 ⇒ 退回宽松判据（沿用 H-02 前行为，不收紧以免误重启健康实例）
at(4242, OURS);
{
  const st = mon.probeInstance({ port: PORT });
  check('L-6 无锚点且 cmdline 可读 ⇒ 退回「像不像 DSH」的宽松判据（不收紧，防误重启健康实例）',
    st.running === true && st.isDsh === true, JSON.stringify(st));
}

// L-7 无锚点 + cmdline 读不到 ⇒ 判「在跑」并标记 identityUnknown（误重启比漏判贵）
at(4242, null);
{
  const st = mon.probeInstance({ port: PORT });
  check('L-7 无锚点且 cmdline 读不到 ⇒ running=true + identityUnknown=true（宁可漏判也不误重启在跑的实例）',
    st.running === true && st.identityUnknown === true && st.portTaken === true, JSON.stringify(st));
}

// L-8 有锚点 + cmdline 读不到 ⇒ 无从比对 ⇒ 同样判「在跑」+ 标记未知（不谎报「没在跑」）
at(4242, null);
{
  const st = mon.probeInstance({ port: PORT }, { anchors: ANCHORS });
  check('L-8 有锚点但 cmdline 读不到 ⇒ identityUnknown=true（身份不可知不冒充已知）',
    st.identityUnknown === true, JSON.stringify(st));
}

// L-9 非法端口不得谎报
at(4242, OURS);
{
  const bads = [0, -1, 1.5, null, undefined, '3080'];
  let ok = true;
  for (const bad of bads) {
    const st = mon.probeInstance({ port: bad }, { anchors: ANCHORS });
    if (st.running !== false || st.portTaken !== false) { ok = false; console.log('   bad ' + JSON.stringify(bad) + ' -> ' + JSON.stringify(st)); }
  }
  const stNone = mon.probeInstance({}, { anchors: ANCHORS });
  check('L-9 端口缺失/非法（0 / 负 / 小数 / null / 字符串 / 无字段）一律 running=false + portTaken=false',
    ok && stNone.running === false && stNone.portTaken === false, JSON.stringify(stNone));
}

// ── L-10..L-12：真实消费点的行为后果 ───────────────────────────────────────────
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
  // L-10 本实例在跑 ⇒ 相位维持 RUNNING，零拉起（不误杀健康实例）
  {
    const { mgr, mkInst, svcCalls, tmp } = mkScenario();
    const inst = mkInst('RUNNING');
    mgr.instances = [inst];
    // 必须用**该实例真实算出的锚点**拼 cmdline：lifecycle 走 sandbox.launchCtx，
    // 其入口锚是临时目录下的 dshEntry，与文件头常量的 OURS 不同（用 OURS 会因锚点不匹配而误判）。
    const anch = require(path.join(ROOT, 'src', 'domains', 'instance', 'sandbox.js'))
      .launchCtx(mgr.instancesRoot, mgr.dshBin, inst).anchors;
    at(4242, 'node ' + anch.join(' ') + ' --host 127.0.0.1 --no-open');
    mgr.supervise('w0b');
    check('L-10 本实例在跑 ⇒ 相位维持 RUNNING 且零拉起（不误杀健康实例）',
      inst.state.phase === 'RUNNING' && svcCalls.length === 0, inst.state.phase + ' ' + svcCalls.join(','));
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }

  // L-11 外来进程占端口 ⇒ 相位离开 RUNNING（守卫重启），而不是一直以为实例在跑
  {
    const { mgr, mkInst, tmp } = mkScenario();
    const inst = mkInst('RUNNING');
    mgr.instances = [inst];
    at(4242, FOREIGN);
    mgr.supervise('w0b');
    check('L-11 外来进程占端口 ⇒ supervise 判实例已退出（相位离开 RUNNING，守卫才会重启）',
      inst.state.phase !== 'RUNNING', inst.state.phase);
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }

  // L-12 启动前占用守卫按 portTaken 拒（占了就是占了，与身份无关）
  {
    const { mgr, mkInst, svcCalls, tmp } = mkScenario();
    const inst = mkInst('STOPPED');
    mgr.instances = [inst];
    const dshEntry = require(path.join(ROOT, 'src', 'domains', 'instance', 'sandbox.js')).dshEntry(mgr.instancesRoot, inst);
    fsx.mkdirSync(path.dirname(dshEntry), { recursive: true });
    fsx.writeFileSync(dshEntry, '// stub entry');
    at(4242, FOREIGN);
    const r = await mgr.startInstance('w0b', { fromUpgrade: true });
    check('L-12 启动前守卫按 portTaken 拒（外来进程占端口 ⇒ 显式拒绝，不下发启动）',
      !!r && r.ok === false && String(r.error).indexOf('已被占用') >= 0 && svcCalls.length === 0,
      JSON.stringify(r) + ' calls=' + svcCalls.join(','));
    try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }
})().catch((e) => {
  check('L-10..L-12 无异常', false, (e && e.message) || String(e));
}).then(() => {
  // 收尾挂在异步链尾：模块末尾的同步 process.exit 会先跑，把 async 块的断言整段掐掉（假绿）。
  process.exit(results.every(Boolean) ? 0 : 1);
});
