#!/usr/bin/env node
'use strict';

// DSH 复杂环境检测兜底回归（tier L2：含平台相关行为 ⇒ 须在 win32/darwin 一并执行；
//   标 L1 会被 R17 判红——本机真实形态是 Windows shim，且 resolveDsh 的 shim 真身解析仅 win32 路径触达）。
// 全部夹具自包含：env 完全隔离（不携带本机 PATH/APPDATA/DSH_BIN），故 ubuntu/win32/darwin 均可稳定复现。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const skip = (n) => console.log('SKIP ' + n + '（本宿主不适用）');

const isWin = (process.platform || '').toLowerCase().indexOf('win32') === 0;

// 在 rootDir 下种一棵与本机一致的 DSH 包：<rootDir>/node_modules/@deepseek-ai/dsh/lib/bin.js + package.json(version)
function plantDsh(rootDir, version) {
  const libBin = path.join(rootDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(libBin), { recursive: true });
  fs.writeFileSync(libBin, '// real dsh entry\n');
  fs.writeFileSync(path.join(rootDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return libBin;
}
function writeShim(shim, libBin) {
  if (isWin) fs.writeFileSync(shim, '"' + process.execPath + '" "' + libBin + '" %*');
  else { fs.writeFileSync(shim, '#!/bin/sh\n' + process.execPath + ' "' + libBin + '" "$@"'); fs.chmodSync(shim, 0o755); }
}
const DT = /node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/;

(async () => {
  const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path'));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'execpath-dsh-'));

  // 1) 一层 shim 指向真实 JS 包（本机真实形态：Roaming\\lobox\\bin\\dsh.cmd -> ~/.dsh-app/lib/bin.js）
  //    win32 下 shim 是 .cmd，resolveDsh 解析 shim 真身拿到 .js；POSIX 下 dsh 一般为裸名指向脚本，不在此断言。
  const shimDir = path.join(TMP, 'bin'); fs.mkdirSync(shimDir, { recursive: true });
  const dshApp = path.join(TMP, 'shim-dsh-app');
  const libBin = plantDsh(dshApp, '0.2.0-rc.2');
  const shim = isWin ? path.join(shimDir, 'dsh.cmd') : path.join(shimDir, 'dsh');
  writeShim(shim, libBin);
  if (isWin) {
    const r1 = ep.resolveDsh({ platform: process.platform, env: { PATH: shimDir, HOME: TMP, USERPROFILE: TMP, APPDATA: TMP, LOCALAPPDATA: TMP } });
    check('shim 解析为真实 JS 入口', !!r1 && r1.isJs === true && r1.bin === libBin, JSON.stringify(r1));
    check('shim 形态的 bin 是真实 .js 文件', !!r1 && r1.isJs === true && DT.test(r1.bin) && fs.existsSync(r1.bin), JSON.stringify(r1));
  } else {
    skip('shim 真身解析（仅 win32 .cmd 触达）');
  }

  // 2) harness-home ~/.dsh-app（空 PATH、无 DSH_BIN、无 npmRoot、无全局 prefix 时仍须识别）
  //    APPDATA/LOCALAPPDATA 一并指向夹具，确保不读本机真实安装。
  const hhHome = path.join(TMP, 'home'); fs.mkdirSync(hhHome, { recursive: true });
  const hhLibBin = plantDsh(path.join(hhHome, '.dsh-app'), '0.2.0-rc.2');
  const r2 = ep.resolveDsh({ platform: process.platform, env: { HOME: hhHome, USERPROFILE: hhHome, APPDATA: hhHome, LOCALAPPDATA: hhHome } });
  check('harness-home 兜底识别', !!r2 && r2.isJs === true && r2.bin === hhLibBin, JSON.stringify(r2));

  // 3) 三兜底都缺失时返回 null（零回归：不误判、不抛）
  const emptyHome = path.join(TMP, 'empty'); fs.mkdirSync(emptyHome, { recursive: true });
  const r3 = ep.resolveDsh({ platform: process.platform, env: { HOME: emptyHome, USERPROFILE: emptyHome, APPDATA: emptyHome, LOCALAPPDATA: emptyHome } });
  check('无安装时返回 null（不误判）', r3 === null, JSON.stringify(r3));

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
