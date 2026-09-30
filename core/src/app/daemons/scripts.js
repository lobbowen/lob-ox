'use strict';

// app/daemons/scripts.js —— 受管 daemon 脚本位置（域名词唯一归属地）。
// platform 只保留通用 resolve 接口，域名词由 app 层持有并注入。
// 不变式：脚本相对 `src/` 的位置未变，仍经 srcpath.resolve 做存在性验证；不存在返回 null（调用方据此降级）。

const path = require('node:path');
const { resolve } = require('../../platform/util/srcpath');

/** daemon 脚本的相对位置（相对 `src/`）。 */
const DAEMON_REL = {
  router: path.join('domains', 'router', 'daemon.js'),
  lan: path.join('domains', 'relay', 'daemon.js'),
};

function daemonScript(kind) {
  const rel = DAEMON_REL[kind];
  if (!rel) return null;
  return resolve(rel);
}

module.exports = { daemonScript, DAEMON_REL };
