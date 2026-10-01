#!/usr/bin/env node
'use strict';


const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-precheck-'));

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = { command: ['node', '/nonexistent/bin/dsh', 'web'], healthUrl: 'http://127.0.0.1:28160/', apiHost: '127.0.0.1', apiPort: 28161,
    stateFile: path.join(TMP, 'state.json'), logFile: path.join(TMP, 'events.log'), supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'), upgradeLogFile: path.join(TMP, 'upg.log') };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const sup = new Supervisor(cfg, cfgPath);
  sup.phase = 'STOPPED';
  sup._startProcess();
  const ok = sup.phase === 'STOPPED' && sup.restartCount === 0 && !sup.child;
  console.log((ok ? 'PASS' : 'FAIL') + ' 未安装时不启动不重试（相位不变 + 无子进程 + restartCount=0）');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
