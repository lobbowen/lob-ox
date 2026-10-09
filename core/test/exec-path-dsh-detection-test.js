#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

(async () => {
  const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path'));
  const isWin = process.platform === 'win32';
  const home = os.homedir();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'execpath-dsh-'));

  // DSH 包布局与本机一致：<home>/.dsh-app/node_modules/@deepseek-ai/dsh/lib/bin.js + package.json(含 version)
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

  // 1) 一层 shim 指向真实 JS 包（本机真实形态：Roaming\\lobox\\bin\\dsh.cmd -> ~/.dsh-app/lib/bin.js）
  const dshApp = path.join(TMP, 'shim-dsh-app');
  const libBin = plantDsh(dshApp, '0.2.0-rc.2');
  const shimDir = path.join(TMP, 'bin'); fs.mkdirSync(shimDir, { recursive: true });
  const shim = isWin ? path.join(shimDir, 'dsh.cmd') : path.join(shimDir, 'dsh');
  writeShim(shim, libBin);
  const r1 = ep.resolveDsh({ platform: process.platform, env: { ...process.env, PATH: shimDir + (isWin ? ';' : ':') + (process.env.PATH || '') } });
  check('shim 解析为真实 JS 入口', !!r1 && r1.isJs === true && r1.bin === libBin, JSON.stringify(r1));
  check('shim 形态的 bin 是真实 .js 文件', !!r1 && r1.isJs === true && /node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(r1.bin) && fs.existsSync(r1.bin));

  // 2) harness-home ~/.dsh-app（无 PATH、无 DSH_BIN、无 npmRoot、无全局 prefix 时仍须识别）
  const fakeHome = path.join(TMP, 'home'); fs.mkdirSync(fakeHome, { recursive: true });
  const hhLibBin = plantDsh(path.join(fakeHome, '.dsh-app'), '0.2.0-rc.2');
  const r2 = ep.resolveDsh({ platform: process.platform, env: { HOME: fakeHome, USERPROFILE: fakeHome } });
  check('harness-home 兜底识别', !!r2 && r2.isJs === true && r2.bin === hhLibBin, JSON.stringify(r2));

  // 3) 三兜底都缺失时返回 null（零回归：不误判、不抛）
  const r3 = ep.resolveDsh({ platform: process.platform, env: { HOME: fakeHome, USERPROFILE: fakeHome } });
  // fakeHome 含 .dsh-app => r2 命中；此处用空目录 home 验证 null 回退
  const emptyHome = path.join(TMP, 'empty'); fs.mkdirSync(emptyHome, { recursive: true });
  const r3b = ep.resolveDsh({ platform: process.platform, env: { HOME: emptyHome, USERPROFILE: emptyHome } });
  check('无安装时返回 null（不误判）', r3b === null, JSON.stringify(r3b));

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
