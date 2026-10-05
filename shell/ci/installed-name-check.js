#!/usr/bin/env node
'use strict';

// 安装冒烟的**装后名字断言**（Linux / macOS / Windows 共用一份实现，被 ci/install-smoke.sh 与
//   ci/install-smoke-win.ps1 调用；四平台同一条判据，不可能只在一个脚本里被修好）。
//
// 为什么要这条断言：安装冒烟此前用通配找装好的二进制（`dpkg -L | grep /usr/bin/*`、`find Contents/MacOS | head -1`、
//   `-like 'lobox*'`），于是「Tauri 把主二进制改成了别的名字」这类不一致**永远查不出来**：通配总能挑到一个文件、
//   探针照样跑得起来，而内核按名字找壳/监控壳的那一侧（brand.js#PROC_MATCH_GUI、PROC_MATCH_GUI_RE）已经失配。
//
// 期望名一律从**单源**派生（不在这里写任何名字字面量）：
//   core/src/shared/brand.js#GUI_BIN_NAME（与 shell/src-tauri/src/brand.rs#GUI_BIN_NAME 逐字对账）
//   + shell/src-tauri/tauri.conf.json#productName（与 brand.js#TAURI_PRODUCT_NAME 逐字对账）
// Tauri v2 的打包语义（本断言的依据，来自 tauri-bundler 源码）：
//   deb  → /usr/bin/<bin.name()>（debian.rs: bin_dir.join(bin.name())）；包名 = kebab(productName)
//   macOS→ <productName>.app/Contents/MacOS/<bin.name()>，Info.plist#CFBundleExecutable = <bin.name()>
//   NSIS → 安装目录 <productName>，主可执行 <bin.name()>.exe
//   其中 <bin.name()> = Cargo 目标名（本仓 Cargo.toml#package.name = GUI_BIN_NAME）；
//   productName **不**改主二进制名（tauri-cli 只在显式配置 mainBinaryName 时 rename_app）。
//
// 用法（argv 全部显式，脚本从平台侧把实测名传进来）：
//   node ci/installed-name-check.js --platform <linux|darwin|win32> --tag <A|B> \
//     --actual-exe <装后二进制的 basename> \
//     [--installer <安装包/应用归档 basename>] [--app-dir <macOS .app 目录名>] \
//     [--cf-bundle-executable <Info.plist#CFBundleExecutable>]
// 不一致 ⇒ 逐条打 `::error file=...,line=...::` 到 stdout 并以非零退出（调用脚本因此判红，不会静默通过）。

const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname; // <仓根>/shell/ci
const BRAND_JS = path.join(HERE, '..', '..', 'core', 'src', 'shared', 'brand.js');
const BRAND_RS = path.join(HERE, '..', 'src-tauri', 'src', 'brand.rs');
const TAURI_CONF = path.join(HERE, '..', 'src-tauri', 'tauri.conf.json');
const REL = (p) => path.relative(path.join(HERE, '..', '..'), p).split(path.sep).join('/');

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.indexOf('--') !== 0) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.indexOf('--') === 0) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

const lineOf = (text, needle) => {
  const i = text.split('\n').findIndex((l) => l.indexOf(needle) >= 0);
  return i < 0 ? 1 : i + 1;
};

function readRustString(src, name) {
  const re = new RegExp('^pub const ' + name + '\\s*:\\s*&str\\s*=\\s*"(.*)";\\s*$', 'm');
  const m = re.exec(src);
  return m ? m[1] : null;
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  const platform = String(args.platform || process.platform);
  const tag = String(args.tag || '?');
  const actualExe = args['actual-exe'] ? String(args['actual-exe']) : '';
  const installer = args.installer ? String(args.installer) : '';
  const appDir = args['app-dir'] ? String(args['app-dir']) : '';
  const cfBundleExecutable = args['cf-bundle-executable'] ? String(args['cf-bundle-executable']) : '';

  if (!actualExe) {
    console.log('::error::installed-name-check 缺 --actual-exe（无法核对装后二进制名）');
    process.exit(2);
  }

  const errors = [];
  const err = (file, line, msg) => errors.push({ file, line, msg });

  const brandSrc = fs.readFileSync(BRAND_JS, 'utf8');
  const rsSrc = fs.readFileSync(BRAND_RS, 'utf8');
  const confSrc = fs.readFileSync(TAURI_CONF, 'utf8');
  const BRAND = require(BRAND_JS);

  // ── S 段：单源之间的对账（三处来源必须逐字一致，否则「期望名」本身就没有唯一答案）──
  const rsGuiBin = readRustString(rsSrc, 'GUI_BIN_NAME');
  if (rsGuiBin !== BRAND.GUI_BIN_NAME) {
    err(REL(BRAND_RS), lineOf(rsSrc, 'pub const GUI_BIN_NAME'),
      '壳二进制名两侧不一致：brand.rs="' + rsGuiBin + '" ≠ brand.js="' + BRAND.GUI_BIN_NAME + '"（跨语言单源已分叉）');
  }
  if (BRAND.GUI_BIN_NAME !== BRAND.GUI_CRATE_NAME) {
    err(REL(BRAND_JS), lineOf(brandSrc, 'const GUI_CRATE_NAME'),
      'GUI_BIN_NAME=' + BRAND.GUI_BIN_NAME + ' ≠ GUI_CRATE_NAME=' + BRAND.GUI_CRATE_NAME
      + '（Tauri 打的是 Cargo 目标名，两者必须同值）');
  }
  const guiForms = Array.isArray(BRAND.GUI_BIN_NAMES) ? BRAND.GUI_BIN_NAMES : [];
  if (guiForms.indexOf(BRAND.GUI_BIN_NAME) < 0 || guiForms.indexOf(BRAND.GUI_BIN_NAME + '.exe') < 0) {
    err(REL(BRAND_JS), lineOf(brandSrc, 'const GUI_BIN_NAMES'),
      'GUI_BIN_NAMES=' + JSON.stringify(guiForms) + ' 未覆盖 ' + JSON.stringify([BRAND.GUI_BIN_NAME, BRAND.GUI_BIN_NAME + '.exe']));
  }
  let conf = null;
  try { conf = JSON.parse(confSrc); } catch (e) {
    err(REL(TAURI_CONF), 1, 'tauri.conf.json 无法解析：' + ((e && e.message) || e));
  }
  if (conf && conf.productName !== BRAND.TAURI_PRODUCT_NAME) {
    err(REL(TAURI_CONF), lineOf(confSrc, '"productName"'),
      'tauri.conf.json#productName="' + conf.productName + '" ≠ 单源 TAURI_PRODUCT_NAME="' + BRAND.TAURI_PRODUCT_NAME + '"');
  }
  if (conf && conf.identifier !== BRAND.TAURI_IDENTIFIER) {
    err(REL(TAURI_CONF), lineOf(confSrc, '"identifier"'),
      'tauri.conf.json#identifier="' + conf.identifier + '" ≠ 单源 TAURI_IDENTIFIER="' + BRAND.TAURI_IDENTIFIER + '"');
  }

  // ── N 段：装后实测名 == 从单源派生的期望名（本脚本存在的理由）──
  const expectExe = platform === 'win32' ? BRAND.GUI_BIN_NAME + '.exe' : BRAND.GUI_BIN_NAME;
  if (actualExe !== expectExe) {
    err(REL(BRAND_JS), lineOf(brandSrc, 'const GUI_BIN_NAME'),
      tag + ' 装后落盘的壳二进制名 "' + actualExe + '" ≠ 单源派生的期望名 "' + expectExe
      + '"（brand.js/brand.rs#GUI_BIN_NAME=' + BRAND.GUI_BIN_NAME + '，Cargo 目标名同值；'
      + 'tauri.conf.json#productName=' + BRAND.TAURI_PRODUCT_NAME + ' 只命名 .app/安装包，不改主二进制名）');
  }

  // 内核按名字认壳的那一侧必须认得出这个装后名（否则 watchdog 判「壳缺失」反复拉起／restartShell 杀不到）。
  let procRe = null;
  try { procRe = new RegExp(BRAND.PROC_MATCH_GUI_RE); } catch (e) {
    err(REL(BRAND_JS), lineOf(brandSrc, 'const PROC_MATCH_GUI_RE'), 'PROC_MATCH_GUI_RE 不是合法正则：' + ((e && e.message) || e));
  }
  if (procRe) {
    if (BRAND.PROC_MATCH_GUI !== BRAND.GUI_BIN_NAME) {
      err(REL(BRAND_JS), lineOf(brandSrc, 'const PROC_MATCH_GUI'),
        'PROC_MATCH_GUI="' + BRAND.PROC_MATCH_GUI + '" ≠ GUI_BIN_NAME="' + BRAND.GUI_BIN_NAME + '"（内核找的不是装后名）');
    }
    if (!procRe.test(actualExe)) {
      err(REL(BRAND_JS), lineOf(brandSrc, 'const PROC_MATCH_GUI_RE'),
        '内核的壳进程判据 ' + BRAND.PROC_MATCH_GUI_RE + ' 认不出装后的 "' + actualExe + '"（壳会被判为缺失）');
    }
    // 反向：判据不得退化成裸产品名（那会把守卫 CLI 与被监管 harness 一并当壳）。
    if (procRe.test(BRAND.PRODUCT_NAME) || procRe.test(BRAND.CLI_NAME)) {
      err(REL(BRAND_JS), lineOf(brandSrc, 'const PROC_MATCH_GUI_RE'),
        '壳进程判据 ' + BRAND.PROC_MATCH_GUI_RE + ' 同时匹配裸产品名/内核 CLI 名（会误杀守卫与 harness）');
    }
  }

  if (platform === 'darwin') {
    const expectApp = BRAND.TAURI_PRODUCT_NAME + '.app';
    if (appDir && appDir !== expectApp) {
      err(REL(TAURI_CONF), lineOf(confSrc, '"productName"'),
        tag + ' 装后 .app 目录名 "' + appDir + '" ≠ productName 派生的 "' + expectApp + '"');
    }
    if (cfBundleExecutable && cfBundleExecutable !== BRAND.GUI_BIN_NAME) {
      err(REL(BRAND_JS), lineOf(brandSrc, 'const GUI_BIN_NAME'),
        tag + ' Info.plist#CFBundleExecutable="' + cfBundleExecutable + '" ≠ GUI_BIN_NAME="' + BRAND.GUI_BIN_NAME + '"');
    }
  }

  if (installer) {
    const okPrefix = installer.indexOf(BRAND.TAURI_PRODUCT_NAME + '_') === 0
      || installer.indexOf(BRAND.TAURI_PRODUCT_NAME + '.') === 0;
    if (!okPrefix) {
      err(REL(TAURI_CONF), lineOf(confSrc, '"productName"'),
        tag + ' 产物名 "' + installer + '" 不是由 productName="' + BRAND.TAURI_PRODUCT_NAME + '" 派生的（前缀不符）');
    }
  }

  if (errors.length) {
    console.log('== 装后名字断言失败（' + tag + ' / ' + platform + '）：' + errors.length + ' 条 ==');
    const grouped = new Map();
    for (const e of errors) {
      const key = e.file + ':' + e.line;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(e.msg);
    }
    for (const [key, msgs] of grouped) {
      const [file, line] = key.split(/:(?=\d+$)/);
      console.log('FAIL ' + key + ' —— ' + msgs.join(' | '));
      console.log('::error file=' + file + ',line=' + line + '::' + msgs.join(' | '));
    }
    process.exit(1);
  }

  console.log('OK 装后名字断言（' + tag + ' / ' + platform + '）：'
    + '实际二进制=' + actualExe + '，期望=' + expectExe
    + '（brand.js/brand.rs#GUI_BIN_NAME），productName=' + BRAND.TAURI_PRODUCT_NAME
    + (installer ? '，产物=' + installer : '')
    + (appDir ? '，.app=' + appDir : '')
    + '；内核判据 ' + BRAND.PROC_MATCH_GUI_RE + ' 认得出');
}

main();
