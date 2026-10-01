'use strict';

// 测试隔离预载（跨平台，不依赖 shell 的 export/set 语法）。
//   每个测试进程一份独立产品状态根：DSH_SUPERVISOR_HOME=<temp>，其 spawn 的子进程继承同一根。
//   Windows cmd 不认 export VAR=...，故只能用 node --require 注入。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.DSH_SUPERVISOR_HOME || !String(process.env.DSH_SUPERVISOR_HOME).trim()) {
  process.env.DSH_SUPERVISOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
}
