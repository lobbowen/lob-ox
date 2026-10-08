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

// 身份判据（全仓唯一一条，字面量只在本函数出现一次）：cmdline 含 `dsh`（大小写不敏）即判 DSH。
// 前项 `/(^|\s)(node|.*dsh.*)(\s|$)/i` 已删：`.*dsh.*` 使其对任何含 dsh 的串恒真 ⇒ 它是空转的装饰，
// 删掉后语义**逐字节不变**（已证：含 dsh 时恒真、不含时恒假）。不引入新语义（O-03 裁定：只显式化）。
// 反例前提（adopt-token-reclaim-test D-12）：`dsh` 是被监管产品的真名，/opt/dsh-tools/x.js 也含它 ⇒
// 本函数只回答「像不像 DSH」，不回答「归不归本守卫管」；后者由 app/main/signals.js 叠加 web 子命令判据。
function isDshCmdlineText(cmd) {
  if (!cmd) return false;
  return /dsh/i.test(cmd);
}

// pid 版：自有读取。调用方若已持有 cmdline（signals/port-rederive 都要再对 cmd 做 web 子命令判据），
// 直接调 isDshCmdlineText 以免同一 pid 读两遍（win32 每次 readCmdline 都是一次 wmic/powershell 子进程）。
function isDshCmdline(pid) {
  return isDshCmdlineText(readCmdline(pid));
}

module.exports = {
  findListeningPid, isAlive, probeAlive, outcomeAlive, isZombie, readCmdline, normCmdline, isDshCmdline, isDshCmdlineText, pgrepList,
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
};
