#!/usr/bin/env node
'use strict';

// 令牌边界回归：supervisor.listLan() 输出剔除 token/dshToken（/lan-access 允许 LAN 访问，防会话令牌泄漏）·
//   InstanceManager.load 剔除历史遗留 dshToken 列（会话令牌不落盘）· /status 仅暴露 dshTokenCaptured 布尔。
//   自包含：构造测试 Supervisor（tmp 状态）+ 覆写 lan 存根，不触碰真实 daemon/账号。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'token-boundary-'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}

function buildSupervisor() {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    healthUrl: 'http://127.0.0.1:28210/',
    apiHost: '127.0.0.1', apiPort: 28211,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    logLevel: 'error',
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return new Supervisor(cfg, cfgPath);
}

async function main() {
  console.log('== 令牌边界：listLan 输出不含会话令牌 ==');
  {
    const sup = buildSupervisor();
    // 本地模式：覆写 lan.list() 返回带 token/dshToken 的伪造项（模拟 relay 缓存内字段）
    sup.lan = {
      list: () => ({ items: [{ id: 'inst-x', name: 'x', dshPort: 3081, wanPort: 28213, token: 'lan-gate-key', dshToken: 'SECRETSESSIONTOKEN', running: true }], addresses: ['192.168.3.64'] }),
    };
    const r = sup.listLan();
    const it = r.items && r.items[0];
    check('listLan 保留结构字段且剔除 remoteToken/dshToken 两个机密字段', !!it && it.id === 'inst-x' && it.wanPort === 28213
      && !Object.prototype.hasOwnProperty.call(it, 'token') && !Object.prototype.hasOwnProperty.call(it, 'dshToken'));
    // 白名单（三态化收口后）：tokenSet 与 remote 视图均为**非机密**（tokenSet 只表明「令牌已设」；
    //   remote = projectRemoteView 产物 {mode,ready,accessUrl,reasons}，accessUrl 是给用户访问的地址）。机密字段仍被剔除。
    check('listLan 输出 remote 视图（tokenSet 已设 → ready 判定归后端）',
      !!it.remote === false || (typeof it.remote.ready === 'boolean' && Array.isArray(it.remote.reasons)),
      JSON.stringify(it.remote));
  }

  console.log('== 令牌边界：注入状态 inject 透传（不含令牌）==');
  {
    const sup = buildSupervisor();
    sup.lan = {
      list: () => ({ items: [{ id: 'inst-r', name: 'r', dshPort: 3081, wanPort: 28213, token: 'k', dshToken: 'SECRET', running: true, inject: { tokenSet: true, cookieReady: true, lastOkAt: 1, lastError: null, lastErrorAt: null } }], addresses: [] }),
    };
    const it = sup.listLan().items[0];
    check('inject 透传 cookieReady', !!it.inject && it.inject.cookieReady === true && it.inject.tokenSet === true);
    check('inject 透传仍无令牌', !!it.inject && !Object.prototype.hasOwnProperty.call(it, 'dshToken') && !Object.prototype.hasOwnProperty.call(it, 'token'));
  }

  console.log('== 令牌边界：instances.json 遗留 dshToken 列剔除 ==');
  {
    fs.writeFileSync(path.join(TMP, 'instances.json'), JSON.stringify({ instances: [{ id: 's1', name: 's', port: 28212, domain: 'sandbox', remoteEnabled: false, dshToken: 'STALEVALUE' }] }));
    const sup = buildSupervisor();
    sup.instances.load();
    const inst = sup.instances.instances.find((x) => x.id === 's1');
    check('load 后内存无 dshToken', inst && !Object.prototype.hasOwnProperty.call(inst, 'dshToken'), inst && Object.keys(inst));
  }

  console.log('== 令牌边界：tokenService 捕获后仅经 get/onChange 分发（模拟单节点语义）==');
  {
    const sup = buildSupervisor();
    let pushed = null;
    const unsub = sup.tokenService.onChange((id, tok) => { pushed = { id, tok }; });
    // attach 必须给可登记的分类（显式 kind；unit 留空以隔离 journal 档，本用例只测 stdout 链路）。
    sup.tokenService.attach('inst-z', { kind: 'dsh-instance', unit: null });
    sup.tokenService.feedLine('inst-z', 'dsh web: http://127.0.0.1:3081/?token=AbC123');
    check('feedLine 捕获成功', sup.tokenService.get('inst-z') === 'AbC123');
    check('onChange 广播', pushed && pushed.id === 'inst-z' && pushed.tok === 'AbC123', pushed);
    // 轮换收敛=同值不广播：置空后重喂同值，回调不得再触发
    pushed = null;
    sup.tokenService.feedLine('inst-z', 'dsh web: http://127.0.0.1:3081/?token=AbC123');
    check('重复相同令牌不重复广播（轮换收敛）', pushed === null, '未再广播');
    // 取消订阅生效：退订后任何新值广播都不得回调
    unsub();
    pushed = null;
    sup.tokenService.feedLine('inst-z', 'dsh web: http://127.0.0.1:3081/?token=ZzZ999');
    check('取消订阅生效（后续广播不再回调）', pushed === null, '未回调');
  }

  console.log('== 令牌边界：clear() 必须同步清空 stdout 残留行（死令牌不得回灌）==');
  {
    const sup = buildSupervisor();
    sup.tokenService.attach('inst-w', { kind: 'dsh-instance', unit: null }); // 合规分类登记（同上）
    sup.tokenService.feedLine('inst-w', 'dsh web: http://127.0.0.1:3081/?token=OLD999');
    check('清除前 capture 正常（前置状态）', sup.tokenService.get('inst-w') === 'OLD999');
    sup.tokenService.clear('inst-w');
    check('clear 后 get 为空串（失效已广播）', sup.tokenService.get('inst-w') === '');
    // capture 不得从残留 stdout 行复活旧令牌（池仍为空是同一状态）。
    const revived = sup.tokenService.capture('inst-w');
    check('capture() 不得从残留行复活旧令牌（且池仍为空）',
      !revived && sup.tokenService.get('inst-w') === '', String(revived) + ' / ' + sup.tokenService.get('inst-w'));
    sup.tokenService.feedLine('inst-w', 'dsh web: http://127.0.0.1:3081/?token=NEW111');
    check('clear 后重喂新行仍可捕获（链路未被清死）', sup.tokenService.get('inst-w') === 'NEW111');
  }

  console.log('== 令牌边界：feedLine 未 attach 旁路封堵 ==');
  {
    const sup = buildSupervisor();
    // 既未 attach、inferKind 又推不出（id 不在 byId、无 unit/file）-> feedLine 必须拒绝入池。
    const r = sup.tokenService.feedLine('ghost-id', 'dsh web: http://127.0.0.1:3081/?token=GHOST');
    check('无法分类的未 attach 源：feedLine 不入池（get 为空）', r === null && sup.tokenService.get('ghost-id') === '', String(r) + '/' + sup.tokenService.get('ghost-id'));
  }

  console.log('== 令牌边界：journal 捕获异步化（不阻塞心跳）==');
  {
    // 行为：注入**永不 settle** 的 journal，capture() 仍须同步返回且不得同步广播（改成「等 journal 再返回」即挂住判红）。
    const { TokenPool } = require(path.join(ROOT, 'src', 'platform', 'service', 'token', 'pool.js'));
    const pool = new TokenPool({ logger: { warn() {}, info() {}, error() {} }, journal: () => new Promise(() => {}) });
    pool.attach('inst-j', { kind: 'dsh-instance', unit: 'u-j' });
    let syncPush = null;
    const un = pool.onChange((id, tok) => { syncPush = { id, tok }; });
    const hit = pool.capture('inst-j');
    un();
    check('journal 档 capture() 同步返回、不等 journal 结果（悬挂 journal 不阻塞心跳）', hit === null && syncPush === null && pool.get('inst-j') === '', '返回=' + String(hit));
  }

  console.log('== 令牌边界：journald 档的服务档闸（无 systemd 单元的机器上没有任何 journal 可查）==');
  {
    const capture = require(path.join(ROOT, 'src', 'platform', 'service', 'token', 'capture.js'));
    const rows = [];
    const lg = { info: (m) => rows.push(String(m)), warn: (m) => rows.push(String(m)) };
    const unit = 'dsh-web@gate-portable';
    const r1 = await capture.captureJournal(unit, { logger: lg, providerKind: () => 'portable' });
    const r2 = await capture.captureJournal(unit, { logger: lg, providerKind: () => 'portable' });
    check('服务档闸 portable 档直接查无（不为不存在的 journal 起子进程）',
      r1 === null && r2 === null, JSON.stringify([String(r1), String(r2)]));
    // 同一日志去重风险的两个表述：「停用一句」与「合计一行」。
    check('服务档闸 停用只落一行（第二拍不得再刷同一句，周期兜底不得变成噪声源）',
      rows.filter((l) => l.indexOf('停用') >= 0).length === 1 && rows.length === 1, JSON.stringify(rows));
    check('服务档闸 落点写明本机服务档', /portable/.test(rows[0] || ''), rows[0]);
    const sysRows = [];
    const sys = await capture.captureJournal('dsh-web@gate-systemd', {
      logger: { info: (m) => sysRows.push(String(m)), warn: (m) => sysRows.push(String(m)) },
      providerKind: () => 'systemd',
    });
    // 反向：闸不得把真有 systemd 的机器也判成停用（砍能力 = 令牌回填链路消失却无人知晓）
    check('服务档闸 systemd 档不被判成停用',
      !sysRows.some((l) => l.indexOf('停用') >= 0), JSON.stringify(sysRows) + ' 返回=' + String(sys));
  }


  console.log('== 令牌边界：journal 回填 attach 世代守卫（在途回填被换代后必须作废）==');
  {
    const { TokenPool } = require(path.join(ROOT, 'src', 'platform', 'service', 'token', 'pool.js'));
    const quiet = { warn() {}, info() {}, error() {} };
    let journalCalls = 0; let late = null;
    // journal 显式注入：返回悬挂 Promise，由用例控制「迟到」时机（CI 无 journalctl，真实档必然查无）。
    const pool = new TokenPool({ logger: quiet, journal: () => { journalCalls += 1; return new Promise((r) => { late = r; }); } });
    const drain = () => new Promise((r) => setTimeout(r, 25));

    // A：detach 时回填已在途（无守卫则死令牌以新 gen 复活并广播）。
    pool.attach('gp', { kind: 'dsh-instance', unit: 'u-gp' });
    pool.capture('gp');
    await drain(); // 让 journal 档真正发射（悬挂中）
    pool.detach('gp');
    late({ token: 'LATE1', source: 'journal', line: 'http://127.0.0.1:3101/?token=LATE1' });
    await drain();
    check('detach 后迟到回填不得复活令牌', pool.get('gp') === '', pool.get('gp'));

    // B：换源重 attach —— 旧代在途结果作废（unit/file 属旧代事实）
    pool.attach('gr', { kind: 'dsh-instance', unit: 'u-gr' });
    pool.capture('gr');
    await drain();
    pool.attach('gr', { kind: 'dsh-instance', unit: 'u-gr-new' });
    late({ token: 'STALE2', source: 'journal', line: 'http://127.0.0.1:3102/?token=STALE2' });
    await drain();
    check('重 attach 后旧代回填不得落池', pool.get('gr') === '', pool.get('gr'));

    // C：未换代的及时回填仍正常落池 —— 守卫不得连带砍死正常链路（防空转判据）
    pool.attach('gq', { kind: 'dsh-instance', unit: 'u-gq' });
    pool.capture('gq');
    await drain();
    late({ token: 'GOOD3', source: 'journal', line: 'http://127.0.0.1:3103/?token=GOOD3' });
    await drain();
    check('同代及时回填仍落池', pool.get('gq') === 'GOOD3', pool.get('gq'));

    // D：发射前就 clear —— journal 档根本不该启动（同步换代先于微任务）
    const callsBefore = journalCalls;
    pool.attach('gs', { kind: 'dsh-instance', unit: 'u-gs' });
    pool.capture('gs');
    pool.clear('gs');
    await drain();
    check('发射前已清除则 journal 不执行', journalCalls === callsBefore, String(journalCalls - callsBefore));
  }


  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
