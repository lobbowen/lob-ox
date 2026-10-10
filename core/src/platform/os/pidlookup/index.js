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

function isDshCmdlineText(cmd) {
  if (!cmd) return false;
  return /dsh/i.test(cmd);
}

function isDshCmdline(pid) {
  return isDshCmdlineText(readCmdline(pid));
}

module.exports = {
  findListeningPid, isAlive, probeAlive, outcomeAlive, isZombie, readCmdline, normCmdline, isDshCmdline, isDshCmdlineText, pgrepList,
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
};
