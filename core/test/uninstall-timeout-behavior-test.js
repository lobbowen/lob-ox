#!/usr/bin/env node
'use strict';

// **行为级**回归：卸载挂起时必须超时收尾并释放锁。造一个永不退出的假 npm（用 node 自己当解释器，
//   绝不用 `#!/bin/sh` —— Windows 无 sh 会退化成立即失败）-> config.uninstallTimeoutMs=800ms -> 调 uninstall()，
//   断言：远小于 sleep 时长内返回、ok=false、timedOut=true、锁已释放。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const { NativeManager } = require(path.join(ROOT, 'src', 'app', 'native', 'installer.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

(async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1f-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // 假 npm：**永不退出**（模拟 registry 挂死 / 凭证助手等待）。**必须跨平台构造**：
  //   写 '#!/bin/sh' + sleep 在 Windows 无法执行 -> spawn 立刻失败 ->「挂起」退化成「立即失败」-> 本测试必红。
  const HANG_JS = 'setTimeout(function () {}, 60000);';   // 60s 不退出（远大于 800ms 超时）
  const fakeNpmHang = path.join(tmp, 'npm-hangs.js');
  fs.writeFileSync(fakeNpmHang, HANG_JS);
  const fakeNpm = process.execPath;                        // 用真实 node 可执行当「解释器」
  const fakeNpmArg = [fakeNpmHang];                        // 由 manager 的 npmBin 支持数组

  // 绝不用「patch 模块导出」替换 npm：`const { npmBin } = require(...)` 是值绑定，patch 无效，
  //   于是「伪造的挂起」会实际执行**真实 npm uninstall -g**；现改为构造期依赖注入（opts.npmBin）。
  const installMod = require(path.join(ROOT, 'src', 'platform', 'distribution', 'install.js'));
  const mgr = new NativeManager({
    config: {
      packageName: '@deepseek-ai/dsh',
      uninstallTimeoutMs: 800, // <- 可注入：真实 15min 无法在测试里等待
      stateDir,
    },
    stateDir,
    npmBin: fakeNpm, // <- 依赖注入：绝不解析到真实 npm
    dist: installMod,
    logger: { info() {}, warn() {}, error() {} },
  });

  // 结构性保险：若将来有人改坏了注入链，这里立刻失败，而不是去跑真实 npm。
  check('前置：npm 已被注入为假可执行（绝不用真实 npm）',
    mgr._npmBin === fakeNpm, String(mgr._npmBin));
  // 注入「以 node 执行该脚本」的参数（跨平台；不依赖 sh）
  mgr._npmBinArgs = fakeNpmArg;

  // 造一份 manifest（否则 uninstall 没有可清理对象；同时验证「超时保留 manifest」）
  const manifestFile = path.join(stateDir, 'native-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    version: '0.0.0-test', packageDir: path.join(tmp, 'pkg'), binPath: path.join(tmp, 'bin'), dataPaths: [],
  }));

  const t0 = Date.now();
  const r = await mgr.uninstall();
  const elapsed = Date.now() - t0;


  // -- 核心断言 --
  check('行为：挂起的 npm 被超时收尾（< 6s 返回，而非等 sleep 1000）',
    elapsed < 6000, elapsed + 'ms');
  check('行为：超时被如实上报（timedOut=true）',
    r && r.timedOut === true, JSON.stringify({ ok: r && r.ok, timedOut: r && r.timedOut }));
  check('行为：结果不是成功', r && r.ok === false, 'ok=' + (r && r.ok));
  check('行为：卸载锁**已释放**（不得永久为真）',
    mgr.uninstalling === null, 'uninstalling=' + String(mgr.uninstalling));
  check('行为：超时后 manifest **保留**（可重试，K10 语义未回退）',
    fs.existsSync(manifestFile), fs.existsSync(manifestFile) ? '保留' : '被误删');

  // -- 反向：看门狗不能误伤正常完成的卸载 --
  {
    // 正常退出的假 npm：同样用 Node 执行（跨平台），立即退出 0。
    const quickJs = path.join(tmp, 'npm-ok.js');
    fs.writeFileSync(quickJs, 'process.exit(0);');
    mgr._npmBin = process.execPath; // 注入正常退出的假 npm（同样绝不碰真实 npm）
    mgr._npmBinArgs = [quickJs];
    mgr.uninstalling = null;
    fs.writeFileSync(manifestFile, JSON.stringify({
      version: '0.0.0-test', packageDir: path.join(tmp, 'pkg2'), binPath: path.join(tmp, 'bin2'), dataPaths: [],
    }));
    const r2 = await mgr.uninstall();
    check('反向：正常退出的 npm 不被误判为超时',
      r2 && r2.ok === true && r2.timedOut !== true, JSON.stringify({ ok: r2 && r2.ok, timedOut: r2 && r2.timedOut }));
    check('反向：正常路径也释放锁', mgr.uninstalling === null, String(mgr.uninstalling));
  }

  // -- D-10：在途 npm 必须**可被关停路径中止** --
  //   npm 子进程 detached 起（自成进程组），守卫退出后它继续存活并写 node_modules/全局前缀。
  //   本块证明：句柄被记账、abort 真杀掉进程组、Promise 不悬挂（ok:false + aborted:true）。
  {
    // 挂起假 npm：复用仓库内夹具 test/fake-npm.js 的 hang 模式（FAKE_MODE 经 env 传入）。
    //   不能把临时脚本路径放进 commandTemplate：Windows runner 的 os.tmpdir() 是 8.3 短名（含 `~`，禁用字符，runNpmInstall 会 fail-closed 拒掉）。
    const pidFile = path.join(tmp, 'inflight-npm.pid');
    process.env.FAKE_MODE = 'hang';
    process.env.FAKE_PID_FILE = pidFile;
    process.env.FAKE_HANG_MS = '60000';
    let p;
    try {
      p = installMod.runNpmInstall({
        pkg: '@deepseek-ai/dsh', version: '9.9.9',
        commandTemplate: [process.execPath, path.join(ROOT, 'test', 'fake-npm.js'), '9.9.9'], timeoutMs: 60000,
      });
    } finally {
      delete process.env.FAKE_MODE; delete process.env.FAKE_PID_FILE; delete process.env.FAKE_HANG_MS;
    }
    check('D-10 行为：在途任务被记账（同步登记，不等子进程输出）',
      installMod.inflightNpmCount() === 1, installMod.inflightNpmCount());
    // 先等子进程把自身 pid 写出来（node 冷启约几十 ms），否则「杀进程」断言会退化成
    // 「在子进程还没跑起来时就杀」——那样 ESRCH 恒真，判据没有牙。
    let childPid = 0;
    for (let i = 0; i < 30 && !childPid; i++) {
      try { childPid = Number(fs.readFileSync(pidFile, 'utf8')); } catch {}
      if (!childPid) await new Promise((res) => setTimeout(res, 50));
    }
    const killed = installMod.killInflightNpm('test-exit');
    const r = await p;
    check('D-10 行为：abort 回报被中止数', killed === 1, killed);
    check('D-10 行为：Promise 以 ok:false + aborted:true 收口（关停不被悬挂的 await 拖住）',
      !!r && r.ok === false && r.aborted === true, JSON.stringify({ ok: r && r.ok, aborted: r && r.aborted, err: r && r.error }));
    check('D-10 行为：句柄注销（不泄漏到下一次关停）',
      installMod.inflightNpmCount() === 0, installMod.inflightNpmCount());
    let dead = false;
    for (let i = 0; i < 20 && !dead; i++) {
      try { process.kill(childPid, 0); } catch (e) { dead = !!(e && e.code === 'ESRCH'); break; }
      await new Promise((res) => setTimeout(res, 100));
    }
    //  childPid 取不到（假 npm 未及写 pid 即被杀）时不算失败——被杀得更快不是缺陷。
    check('D-10 行为：子进程真的消失（ESRCH），不是只解除了 await',
      childPid === 0 || dead === true, 'pid=' + childPid + ' dead=' + dead);
    // 反向（判据有牙）：确认子进程确实活着过，否则本块的 ESRCH 无意义
    check('D-10 反向：pid 文件已写出（子进程真的启动过）', childPid > 0, 'pid=' + childPid);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });