'use strict';

function parseProcNetTcpInodes(txt, port) {
  const inodes = new Set();
  for (const lineRaw of String(txt || '').split('\n')) {
    const cols = lineRaw.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const local = cols[1];
    const st = cols[3];
    const inode = cols[9];
    if (!local || !inode) continue;
    const p = local.split(':')[1];
    if (st === '0A' && p && parseInt(p, 16) === port) inodes.add('socket:[' + inode + ']');
  }
  return inodes;
}

function parseLsofPid(out) {
  for (const line of String(out || '').split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.length >= 2 && /^\d+$/.test(m[1])) return Number(m[1]);
  }
  return null;
}

function parseNetstatPid(out, port) {
  const want = String(port);
  for (const line of String(out || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5 && (parts[0] === 'TCP' || parts[0] === 'TCPv6') && parts[3] === 'LISTENING') {
      const lp = parts[1];
      const p = lp.slice(lp.lastIndexOf(':') + 1);
      if (p === want) {
        const pid = Number(parts[4]);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    }
  }
  return null;
}

function parseSsPid(out) {
  const m = out && /pid=(\d+)/.exec(String(out));
  return m ? Number(m[1]) : null;
}

function parseWmicCommandLine(out) {
  if (!out) return null;
  const m = /CommandLine=([\s\S]*)/.exec(String(out));
  const v = m ? m[1].trim() : '';
  return v || null;
}

function parsePowerShellCommandLine(out) {
  const v = out ? String(out).trim() : '';
  return v || null;
}

function normCmdline(s) { return String(s || '').replace(/\\/g, '/'); }

module.exports = {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
  normCmdline,
};
