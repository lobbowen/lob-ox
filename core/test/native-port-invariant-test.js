#!/usr/bin/env node
'use strict';


const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

const probe = require(path.join(ROOT, 'src', 'app', 'native', 'probe.js'));

check('F-1 targetPort 以 config.targetPort 为权威（真实 spawn 端口优先于 healthUrl）',
  probe.targetPort({ targetPort: 4000, healthUrl: 'http://127.0.0.1:3080/' }) === 4000,
  String(probe.targetPort({ targetPort: 4000, healthUrl: 'http://127.0.0.1:3080/' })));
check('F-2 targetPort 不可用时才回落 healthUrl 派生',
  probe.targetPort({ healthUrl: 'http://127.0.0.1:3080/' }) === 3080,
  String(probe.targetPort({ healthUrl: 'http://127.0.0.1:3080/' })));
check('F-3 坏 healthUrl 不抛错（返回 null，由调用方显式失败）',
  probe.targetPort({ healthUrl: 'not-a-url' }) === null, String(probe.targetPort({ healthUrl: 'not-a-url' })));
const cfgSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'config.js'), 'utf8');
check('F-4 config 强制了 healthUrl 端口 == targetPort 的不变量（此前无人强制 ⇒ 升级等错端口会回滚健康实例）',
  cfgSrc.includes('u.port = String(cfg.targetPort)') && cfgSrc.includes('cfg.healthUrl = u.toString()'), '源码判据');

process.exit(results.every(Boolean) ? 0 : 1);
