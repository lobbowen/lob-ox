'use strict';

// 每个测试进程一份独立产品状态根 DSH_SUPERVISOR_HOME=<temp>；Windows cmd 不认 export VAR=...，故只能用 node --require 注入。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.DSH_SUPERVISOR_HOME || !String(process.env.DSH_SUPERVISOR_HOME).trim()) {
  process.env.DSH_SUPERVISOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
}
