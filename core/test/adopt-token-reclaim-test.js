#!/usr/bin/env node
'use strict';

// 守卫「令牌不得驱动生命周期」：令牌缺失/空置不得触发任何 phase 迁移或重启（正向 + 反向对照）。
// 运行：node --require ./test/_preload.js test/adopt-token-reclaim-test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// 端口取自 test/_ports.js（避开 OS ephemeral 与生产池）。
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-token-reclaim-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  <- ' + extra : ''));
  }
}

function buildSupervisor(overrides = {}) {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    // 探测端口取本文件专属安全段，且**刻意无监听**：让每拍都落在 L1 离线分支。
    healthUrl: 'http://127.0.0.1:' + safePort('adopt-token-reclaim', 0) + '/',
    apiHost: '127.0.0.1', apiPort: safePort('adopt-token-reclaim', 1),
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    // 健康阈值拉高：本用例只关心「令牌 -> 迁移」，不让「端口无监听 -> 连续假死」这条
    //   正当的进程健康路径混进来污染断言。
    failThreshold: 1000,
    ...overrides,
  };
  const cfgPath = path.join(TMP, 'cfg-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const sup = new Supervisor(cfg, cfgPath);
  // daemon 模式下守卫无本地 relay 能力，get lan 恒为 null ⇒ 收敛尾部的 this.lan.reconcile()
  //   不会真去建 relay（否则测试进程会写 ports.json / 起反代）。这是隔离手段，不影响本用例路径。
  sup.lanDaemonEnabled = () => true;
  return sup;
}


async function main() {


  console.log('== 运行时：令牌缺失不得触发 phase 迁移/重启 ==');
  {
    const sup = buildSupervisor({ tokenReclaimGraceMs: 1 });
    const restarts = [];
    sup._beginRestart = (reason, opts) => { restarts.push({ reason, opts }); };
    const stops = [];
    sup.stopProcess = (reason) => { stops.push(reason); };

    // 场景 A：RUNNING + 被接管（adoptedPid 非空、无 child、令牌空置），观察窗只给 1ms。
    //   存活/死亡用真实事实表达（isAlive = process.kill(pid,0)），不伪造判定。
    const ALIVE_PID = process.pid;
    const DEAD_PID = 4000000; // 远超 Linux pid_max（默认上限内亦不存在的低位值）
    const realGuardian = sup.state.guardian;

    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.observedOnly = false;
    sup.adoptedPid = process.pid; // 用存活的本进程 pid，避免把"进程真死了"的重启混进来
    sup.child = null;
    await sleep(20); // 远超观察窗，确保不是"还没到窗口"
    const phaseA0 = sup._mPhase();
    await sup._dshConverge();
    check('A: 令牌空置且被接管，phase 不迁移（无重建）', restarts.length === 0 && sup._mPhase() === phaseA0, JSON.stringify({ restarts, phaseA0, now: sup._mPhase() }));
    check('A: 未产生任何 stopProcess', stops.length === 0, JSON.stringify(stops));

    // 场景 B：RUNNING + 自 spawn（有 child 管道、令牌空置）——同样不得因令牌重启。
    sup.phase = 'RUNNING';
    sup.adopted = false;
    sup.child = { pid: process.pid, exitCode: null, signalCode: null };
    sup.adoptedPid = null;
    restarts.length = 0;
    await sup._dshConverge();
    check('B: 自 spawn 且令牌空置，不触发重建', restarts.length === 0, JSON.stringify(restarts));

    // 场景 C（反向对照）：被接管 pid 也"活着"、令牌空置，仍不得重启 —— 合不出「令牌缺失 +
    //   接管进程不可达」合成的重启。
    sup.phase = 'RUNNING';
    sup.adopted = true;
    sup.adoptedPid = ALIVE_PID;
    sup.child = null;
    restarts.length = 0;
    await sup._dshConverge();
    check('C: 接管进程存活 + 令牌空置，不触发重建', restarts.length === 0, JSON.stringify(restarts));
    check('C: phase 仍为 RUNNING', sup._mPhase() === 'RUNNING', sup._mPhase());

    // 场景 D（反向对照）：接管 pid 不可达 + 守护开启 ⇒ 重启原因必须是 adopted_exit（进程维度），
    //   绝不能是任何令牌维度。守护开关置 true 是必要条件：guardian=false 时进程死亡本就只停不拉，
    //   测出"无重启"就没有区分度。
    sup.state.guardian = () => true;
    try {
      sup.phase = 'RUNNING';
      sup.adopted = true;
      sup.adoptedPid = DEAD_PID;
      sup.child = null;
      restarts.length = 0;
      await sup._dshConverge();
      const reasons = restarts.map((r) => r.reason);
      check('D: 进程失联仅以进程维度触发重启（reason=adopted_exit，绝无令牌维度）', reasons.length === 1 && reasons[0] === 'adopted_exit', JSON.stringify(reasons));
    } finally { sup.state.guardian = realGuardian; }
  }

  console.log('== 阴影排除集：不再豁免任何令牌类 reason，但保留异步钩子豁免 ==');
  {
    const sup = buildSupervisor({});
    check('升级钩子仍被排除（排除机制未空转）', sup._shadowExcluded('upgrade_hold') === true);
    check('假死仍被排除', sup._shadowExcluded('http_unhealthy') === true);
    check('普通迁移（如 start_timeout）不被排除', sup._shadowExcluded('start_timeout') === false);
  }

  // -- D-11：接管必须有归属凭据（dsh-main.owner.json），不得只凭 cmdline 相似（否则双管家互杀）--
  //   凭据**只做否决**：他主存活则不接管；陈旧凭据（pid 被内核复用）不得单独放行，放行权威仍是 cmdline。
  {
    const { spawn, spawnSync } = require('node:child_process');
    // 让 cmdline 判定在本进程上为真：command[1] 取测试自身命令行里的可辨识片段。
    const sup2 = buildSupervisor({ command: ['node', 'adopt-token-reclaim-test.js', 'web'] });
    const f = sup2._mainOwnerFile();
    check('D-11 凭据与 daemon 身份/锁文件同址（stateFile 目录）',
      f === path.join(TMP, 'dsh-main.owner.json'), f);
    check('D-11 无凭据：read=null 且接管判定回落 cmdline（本进程形态可接管）',
      sup2._readMainOwner() === null && sup2._isManagedProcess(process.pid) === true,
      'read=' + String(sup2._readMainOwner()));

    sup2._writeMainOwner(4242, 3080);
    const o = sup2._readMainOwner();
    check('D-11 写后读回 {guardPid=本守卫, dshPid, port}',
      !!o && o.dshPid === 4242 && o.guardPid === process.pid && o.port === 3080, JSON.stringify(o));
    // 原子写单源：该文件的任何派生 tmp（<file>.tmp.<pid>.<ts>）都不得残留。
    const ownerStrays = fs.readdirSync(path.dirname(f))
      .filter((x) => x.startsWith(path.basename(f) + '.tmp'));
    check('D-11 原子写：不留 .tmp 残留（按派生名枚举，不依赖具体命名）',
      ownerStrays.length === 0, ownerStrays.join(',') || 'clean');
    // 权限位是 POSIX 语义：Windows 的 chmod 只切换只读位（mode 恒 666），此处只做 POSIX 行为断言。
    if (process.platform !== 'win32') {
      check('D-11 落盘权限 0600', (fs.statSync(f).mode & 0o777) === 0o600,
        (fs.statSync(f).mode & 0o777).toString(8));
    } else console.log('SKIP D-11 权限位断言（Windows 无 POSIX mode；chmodSync 仅切换只读位）');

    // 「另一个存活的守卫」：起一个真实子进程当它（win 上 pid 1 是空闲进程，不能代表存活）。
    const other = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 5000);'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(f, JSON.stringify({ guardPid: other.pid, dshPid: process.pid, port: 3080, startedAt: 0 }));
      check('D-11 否决：他主存活守卫拥有该 pid 时绝不接管（即使 cmdline 匹配）',
        sup2._isManagedProcess(process.pid) === false, '已否决');
    } finally { try { other.kill('SIGKILL'); } catch {} }

    // 陈旧凭据（原守卫已死）-> 不否决：接管链路不能被一次崩溃永久封死。
    const dead = spawnSync(process.execPath, ['-e', '']);
    fs.writeFileSync(f, JSON.stringify({ guardPid: dead.pid, dshPid: process.pid, port: 3080, startedAt: 0 }));
    check('D-11 反向：他主**已死**的凭据不否决接管（陈旧凭据不封死恢复）',
      dead.pid && sup2._isManagedProcess(process.pid) === true, 'guardPid=' + dead.pid);
    // 自持凭据（本进程 pid）与凭据指向别的 pid 同属「不否决」。
    fs.writeFileSync(f, JSON.stringify({ guardPid: process.pid, dshPid: process.pid, port: 3080, startedAt: 0 }));
    const selfOk = sup2._isManagedProcess(process.pid) === true;
    fs.writeFileSync(f, JSON.stringify({ guardPid: 999998, dshPid: 999997, port: 3080, startedAt: 0 }));
    check('D-11 自持凭据 / 凭据指向别的 pid 均不否决（放行）',
      selfOk && sup2._isManagedProcess(process.pid) === true, '放行');
    try { fs.unlinkSync(f); } catch {}
  }

  // -- D-12：cmdline 兜底必须认「DSH 形态」（带 web 子命令），不得只认「命令行里出现过 dsh」--
  //   否则路径含 dsh 的无关进程只要占着 target 端口就被接管并 SIGTERM（误杀无关进程）。
  //   反向：路径不含配置 bin 但带 web 子命令的真「手动标准安装」形态必须仍放行。
  {
    const { spawn } = require('node:child_process');
    const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    // 配置 bin 用默认 /nonexistent/bin/dsh：两个子进程都不含它，判定只能走兜底分支。
    const sup3 = buildSupervisor({});
    try { fs.unlinkSync(sup3._mainOwnerFile()); } catch {}
    const IDLE = 'setTimeout(function () {}, 8000);';
    const kids = [];
    const alive = async (pid) => {
      for (let i = 0; i < 40; i++) { if (pidlook.isAlive(pid)) return true; await sleep(50); }
      return false;
    };
    const cmdOf = (pid) => (pidlook.readCmdline(pid) || '').slice(0, 120);
    try {
      // (a) 手动起的标准 DSH：路径与配置 bin 无关，但带 web 子命令 -> 可接管
      const manual = spawn(process.execPath,
        ['-e', IDLE, path.join(TMP, 'manual-dsh-bin'), 'web', '--port', '3080'], { stdio: 'ignore' });
      kids.push(manual);
      check('D-12 对照组 (a) 子进程已起', await alive(manual.pid), 'pid=' + manual.pid);
      check('D-12 带 web 子命令的手动 DSH 仍判可接管（路径不含配置 bin）',
        sup3._isManagedProcess(manual.pid) === true, 'cmd=' + cmdOf(manual.pid));
      // (b) 无关进程：命令行含 dsh 字样但无 web 子命令 -> 绝不接管
      const stranger = spawn(process.execPath,
        ['-e', IDLE, '/opt/dsh-supervisor/tools/build-cache.js'], { stdio: 'ignore' });
      kids.push(stranger);
      check('D-12 对照组 (b) 子进程已起', await alive(stranger.pid), 'pid=' + stranger.pid);
      const sCmd = cmdOf(stranger.pid);
      check('D-12 反例前提：该 cmdline 确实含 dsh 字样（否则判据空转）', /dsh/i.test(sCmd), sCmd);
      check('D-12 只含 dsh 字样、无 web 子命令的进程不得判可接管（误杀源头）',
        sup3._isManagedProcess(stranger.pid) === false, 'cmd=' + sCmd);
    } finally {
      for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
    }
  }

  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
