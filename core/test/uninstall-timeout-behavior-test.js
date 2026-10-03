#!/usr/bin/env node
'use strict';


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

  // 假 npm 必须跨平台构造：'#!/bin/sh' + sleep 在 Windows 无法执行 ⇒「挂起」退化成「立即失败」。
  const HANG_JS = 'setTimeout(function () {}, 60000);';   // 60s 不退出（远大于 800ms 超时）
  const fakeNpmHang = path.join(tmp, 'npm-hangs.js');
  fs.writeFileSync(fakeNpmHang, HANG_JS);
  const fakeNpm = process.execPath;                        // 用真实 node 可执行当「解释器」
  const fakeNpmArg = [fakeNpmHang];                        // 由 manager 的 npmBin 支持数组

  // 绝不用 patch 模块导出替换 npm：const { npmBin } = require(...) 是值绑定，patch 无效 ⇒ 伪造的挂起会实际执行真实 npm uninstall -g；改用构造期注入（opts.npmBin）。
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

  check('前置：npm 已被注入为假可执行（绝不用真实 npm）',
    mgr._npmBin === fakeNpm, String(mgr._npmBin));
  mgr._npmBinArgs = fakeNpmArg;

  const manifestFile = path.join(stateDir, 'native-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    version: '0.0.0-test', packageDir: path.join(tmp, 'pkg'), binPath: path.join(tmp, 'bin'), dataPaths: [],
  }));

  const t0 = Date.now();
  const r = await mgr.uninstall();
  const elapsed = Date.now() - t0;


  check('行为：挂起的 npm 被超时收尾（< 6s 返回，而非等 sleep 1000）',
    elapsed < 6000, elapsed + 'ms');
  check('行为：超时被如实上报（timedOut=true）',
    r && r.timedOut === true, JSON.stringify({ ok: r && r.ok, timedOut: r && r.timedOut }));
  check('行为：结果不是成功', r && r.ok === false, 'ok=' + (r && r.ok));
  check('行为：卸载锁**已释放**（不得永久为真）',
    mgr.uninstalling === null, 'uninstalling=' + String(mgr.uninstalling));
  check('行为：超时后 manifest **保留**（可重试，K10 语义未回退）',
    fs.existsSync(manifestFile), fs.existsSync(manifestFile) ? '保留' : '被误删');

  {
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

  {
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
    // 先等子进程写出自身 pid，否则「杀进程」断言会退化成「子进程还没跑起来就杀」——ESRCH 恒真，判据没有牙。
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
    check('D-10 行为：子进程真的消失（ESRCH），不是只解除了 await',
      childPid === 0 || dead === true, 'pid=' + childPid + ' dead=' + dead);
    check('D-10 反向：pid 文件已写出（子进程真的启动过）', childPid > 0, 'pid=' + childPid);
  }


  {
    // W2/O-16：安装期禁用生命周期脚本是**安全姿态**，必须在所有安装路径上都成立。
    // 此前 --ignore-scripts 只写在默认分支 ⇒ 用户配了 commandTemplate 就静默失去该保护（两条路径两套语义）。
    // 这里钉**行为**：两条路径实跑，各自断言 argv 里确有该标志（源码形态由 R12 管，行为由本测试管）。
    const runFake = async (opts) => {
      const { spawnSync } = require('node:child_process');
      // 直接调 install.js 并让 fake-npm 回吐 argv
      process.env.FAKE_MODE = 'argv';
      let out;
      try {
        const p = installMod.runNpmInstall(Object.assign({
          pkg: '@deepseek-ai/dsh', version: '9.9.9',
          commandTemplate: [process.execPath, path.join(ROOT, 'test', 'fake-npm.js')], timeoutMs: 30000,
        }, opts || {}));
        const r = await p;
        out = (r && r.output ? r.output.join('\n') : '');
      } finally { delete process.env.FAKE_MODE; }
      const m = /FAKE-ARGV (\{.*\})/.exec(out);
      return m ? JSON.parse(m[1]).argv : null;
    };
    // 路径A：commandTemplate（模板分支）
    const argvTpl = await runFake({ commandTemplate: [process.execPath, path.join(ROOT, 'test', 'fake-npm.js')] });
    // 路径B：无模板（默认分支）⇒ 用 launcher 注入，走 fake-npm 作 npm
    const argvDefault = await runFake({
      commandTemplate: null,
      launcher: { program: process.execPath, args: [path.join(ROOT, 'test', 'fake-npm.js')] },
    });
    check('W2-A 模板分支：安装命令含 --ignore-scripts（安全姿态不得因用户配模板而消失）',
      Array.isArray(argvTpl) && argvTpl.includes('--ignore-scripts'), JSON.stringify(argvTpl));
    check('W2-B 默认分支：安装命令含 --ignore-scripts（既有行为不变）',
      Array.isArray(argvDefault) && argvDefault.includes('--ignore-scripts'), JSON.stringify(argvDefault));
    // 反向：用户显式写了 --no-ignore-scripts ⇒ 尊重用户，不得再补 --ignore-scripts（不覆盖人的明确意图）。
    const argvExplicit = await runFake({
      commandTemplate: [process.execPath, path.join(ROOT, 'test', 'fake-npm.js'), '--no-ignore-scripts'],
    });
    check('W2-C 反向：用户显式 --no-ignore-scripts 时尊重用户（不补 --ignore-scripts、不覆盖明确意图）',
      Array.isArray(argvExplicit) && argvExplicit.includes('--no-ignore-scripts')
      && !argvExplicit.includes('--ignore-scripts'), JSON.stringify(argvExplicit));
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });