'use strict';

const {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine, normCmdline,
} = require('./norm');
const {
  linuxFind, linuxFindSs, macFind, winFind, readCmdline, pgrepList, isAlive, probeAlive, isZombie, outcomeAlive,
} = require('./probe');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';

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

// R8：判据从硬编码 /dsh/i 改为读 BRAND.PROC_MATCH_GUARD（shared-constants.json）。
// 原缺陷有两层：产品已从 dsh-supervisor 改名为 lobox，/dsh/i 匹配不到 lobox 可执行文件；
// 且 matchGuard 原值 "*lobox*" 也匹配不到真实 npm scope 路径 "@lob-ox/core-win-x64"
// （连字符 ≠ 无连字符）。现已修正常量为 "*lobox*|*lob-ox*|*dsh*" 覆盖三种真实形态：
// CLI/壳可执行名 lobox、npm scope lob-ox、旧产品名 dsh 的历史安装。
// 消费者：os/liveness.js 的 known 判据、service/monitor.js 的 isDsh 判据（无锚点兜底路径）。
const BRAND_PROC_GUARD = require('../../../shared/brand').PROC_MATCH_GUARD;
const GUARD_RE = (() => {
  const g = String(BRAND_PROC_GUARD || '').trim();
  if (!g) return /dsh|lobox/i;
  // "*lobox*" -> /lobox/i；多段（如 "*lobox*|*dsh*"）取并集。
  const parts = g.split('|').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/^\*+/, '').replace(/\*+$/, '')).filter(Boolean);
  if (!parts.length) return /dsh|lobox/i;
  return new RegExp(parts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
})();

function isDshCmdlineText(cmd) {
  if (!cmd) return false;
  return GUARD_RE.test(String(cmd));
}

function isDshCmdline(pid) {
  return isDshCmdlineText(readCmdline(pid));
}

module.exports = {
  findListeningPid, isAlive, probeAlive, outcomeAlive, isZombie, readCmdline, normCmdline, isDshCmdline, isDshCmdlineText, pgrepList,
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
};
