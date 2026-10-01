#!/usr/bin/env node
'use strict';

// hang 走环境变量而非 argv：commandTemplate 要过禁用字符集，而 Windows runner 的 os.tmpdir() 是 8.3 短名（含禁用字符 ~）。

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
