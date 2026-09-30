#!/usr/bin/env node
'use strict';

// 升级测试用假安装器：模拟 npm install -g 的成功/失败，不碰真实 npm。
// 用法: node fake-npm.js <version>
// 环境变量:
//   FAKE_PKG_JSON  要改写的 package.json 路径（ok/fail 模式必填；hang/argv 模式不需要）
//   FAKE_MODE      ok(默认)=改写版本并退出0 | fail=退出3 | hang=报出自身 pid 后挂住不退出
//                  | argv=回显收到的 argv 与 registry 环境变量后退出 0（执行器构造判据用）
//   FAKE_PID_FILE  hang 模式：把自身 pid 写到这里（D-10 用它证明「子进程真的活过」）
//   FAKE_HANG_MS   hang 模式挂起时长，默认 60000
//
//  为什么 hang 用**环境变量**而不是 argv：
//   runNpmInstall 的 commandTemplate 逐项过禁用字符集（B11 fail-closed），而 Windows
//   runner 的 os.tmpdir() 是 **8.3 短名** `C:\Users\RUNNER~1\AppData\Local\Temp\…`，
//   `~` 属禁用字符 -> 合法的临时脚本路径被拒。pid 文件路径经 env 传入，argv 只留仓库内路径。

const fs = require('node:fs');

const version = process.argv[2];
const pkgPath = process.env.FAKE_PKG_JSON;
const mode = process.env.FAKE_MODE || 'ok';

if (mode === 'hang') {
  const pidFile = process.env.FAKE_PID_FILE;
  if (pidFile) { try { fs.writeFileSync(pidFile, String(process.pid)); } catch {} }
  console.log('[fake-npm] hang pid=' + process.pid);
  setTimeout(function () {}, Number(process.env.FAKE_HANG_MS || 60000));
  return;
}

if (mode === 'argv') {
  // 回显口：让门禁看到**执行器真正构造出来的** argv 与注入的 registry，而不是它以为的。
  // 静态正则只能证明代码里有这个字面量，证不了「装/卸两条分支各自落到哪份 argv」。
  console.log('FAKE-ARGV ' + JSON.stringify({
    argv: process.argv.slice(2),
    registry: process.env.npm_config_registry || null,
  }));
  process.exit(0);
}

console.log(`[fake-npm] install ${version} mode=${mode}`);

if (!pkgPath || !version) {
  console.error('[fake-npm] missing args');
  process.exit(2);
}

if (mode === 'fail') {
  console.error('[fake-npm] simulated failure');
  process.exit(3);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
console.log(`[fake-npm] wrote ${pkgPath} -> ${version}`);
process.exit(0);
