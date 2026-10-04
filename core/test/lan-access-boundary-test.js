#!/usr/bin/env node
'use strict';

// 双向锁定 originAllowed：RFC1918 的 Host/Origin 必须 ALLOW，恶意 Origin / DNS-rebinding Host / 公网 IP Host/Origin 必须仍 DENY —— 放宽任何一侧都红。
// 边界：172.32.x / 172.15.x（非私有）→ DENY；缺 Host → DENY（fail-closed）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const { originAllowed } = require(path.join(ROOT, 'src', 'api', 'index.js'));

const PORT = '37360';
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const allow = (h) => originAllowed({ headers: h }, PORT);

check('E-a 192.168.x 浏览器（Host+Origin 同源）→ ALLOW',
  allow({ host: '192.168.1.5:' + PORT, origin: 'http://192.168.1.5:' + PORT }) === true);
check('E-a 10.x 网段 → ALLOW',
  allow({ host: '10.0.0.7:' + PORT, origin: 'http://10.0.0.7:' + PORT }) === true);
check('E-a 172.16.x 网段 → ALLOW',
  allow({ host: '172.16.3.9:' + PORT, origin: 'http://172.16.3.9:' + PORT }) === true);
check('E-a 172.31.x（私有上界）→ ALLOW',
  allow({ host: '172.31.255.254:' + PORT }) === true);
check('E-a 局域网无 Origin（curl）→ ALLOW',
  allow({ host: '192.168.1.5:' + PORT }) === true);

check('E-b 回环 Host+Origin → ALLOW',
  allow({ host: '127.0.0.1:' + PORT, origin: 'http://127.0.0.1:' + PORT }) === true);
check('E-b 回环无 Origin（本机 curl）→ ALLOW', allow({ host: '127.0.0.1:' + PORT }) === true);
check('E-b 壳 Origin（tauri://localhost）→ ALLOW',
  allow({ host: '127.0.0.1:' + PORT, origin: 'tauri://localhost' }) === true);

check('E-c 恶意 Origin（evil.com）→ DENY',
  allow({ host: '127.0.0.1:' + PORT, origin: 'http://evil.com' }) === false);
check('E-d DNS-rebinding（Host=evil.com）→ DENY',
  allow({ host: 'evil.com:' + PORT, origin: 'http://127.0.0.1:' + PORT }) === false);
check('E-e 公网 IP Host（8.8.8.8）→ DENY', allow({ host: '8.8.8.8:' + PORT }) === false);
check('E-e 缺 Host → DENY（C-1 fail-closed）', allow({}) === false);
check('E-e 公网 IP Origin → DENY',
  allow({ host: '127.0.0.1:' + PORT, origin: 'http://8.8.8.8:' + PORT }) === false);
check('E-f 边界：172.32.x（非私有）→ DENY', allow({ host: '172.32.0.1:' + PORT }) === false);
check('E-f 边界：172.15.x（非私有）→ DENY', allow({ host: '172.15.0.1:' + PORT }) === false);

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);