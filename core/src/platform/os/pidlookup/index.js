'use strict';

// pidlookup 门面：平台分派 + 导出面。三端同一接口 findListeningPid(port) 返回 number|null；
// 平台差异全部下沉 probe.js（IO）/ norm.js（纯）。

const {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine, normCmdline,
} = require('./norm');
const {
  linuxFind, linuxFindSs, macFind, winFind, readCmdline, pgrepList, isAlive, probeAlive, isZombie,
} = require('./probe');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';

/** 找到监听 port 的进程 pid；找不到或环境不支持返回 null。 */
function findListeningPid(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  if (isLinux) {
    const a = linuxFind(port);
    if (a !== null && a !== undefined) return a;
    return linuxFindSs(port);
  }
  if (isMac) return macFind(port);
  return winFind(port);
}

/** 判断进程命令行是否匹配 DSH 特征（三平台可用）。 */
function isDshCmdline(pid) {
  const cmd = readCmdline(pid);
  if (!cmd) return false;
  return /(^|\s)(node|.*dsh.*)(\s|$)/i.test(cmd) && /dsh/i.test(cmd);
}

module.exports = {
  findListeningPid, isAlive, probeAlive, isZombie, readCmdline, normCmdline, isDshCmdline, pgrepList,
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
};
