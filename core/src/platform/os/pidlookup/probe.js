'use strict';

const fs = require('node:fs');
const ex = require('../../util/exec');
const { isExecutableFile } = require('../exec-path');
const {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
} = require('./norm');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

function linuxListeningInodes(port) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const x of parseProcNetTcpInodes(txt, port)) inodes.add(x);
  }
  return inodes;
}

function linuxFind(port) {
  try {
    const inodes = linuxListeningInodes(port);
    if (!inodes.size) return null;
    const entries = fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e));
    for (const pid of entries) {
      let fds;
      try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch { continue; }
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch { continue; }
        if (inodes.has(link)) return Number(pid);
      }
    }
  } catch {}
  return null;
}

function macFind(port) {
  try {
    const out = ex.runOut('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeoutMs: 3000 });
    if (!out) return null;
    return parseLsofPid(out);
  } catch {}
  return null;
}

function winFind(port) {
  try {
    const out = ex.runOut('netstat', ['-ano'], { timeoutMs: 3000 });
    if (!out) return null;
    return parseNetstatPid(out, port);
  } catch {}
  return null;
}

function linuxFindSs(port) {
  const candidates = ['ss', '/usr/sbin/ss', '/usr/bin/ss', '/bin/ss'];
  for (const ssBin of candidates) {
    if (ssBin.includes('/') && !isExecutableFile(ssBin)) continue;
    try {
      const out = ex.runOut(ssBin, ['-tlnHp', 'sport = :' + port], { timeoutMs: 3000 });
      const pid = parseSsPid(out);
      if (pid !== null) return pid;
    } catch {}
  }
  return null;
}

function probeAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try { process.kill(pid, 0); return 'alive'; }
  catch (e) {
    const code = e && e.code;
    if (code === 'EPERM') return 'alive';
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function isAlive(pid) {
  return probeAlive(pid) === 'alive';
}

// zombie：kill(pid,0) 仍为 true 但端口/stdio 已释放，停服等待须区分；linux 读 /proc/<pid>/stat，macOS 走 ps state，win32 恒 false。
function isZombie(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || isWindows) return false;
  if (isLinux) {
    try {
      const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const idx = st.lastIndexOf(') ');
      return idx >= 0 && st[idx + 2] === 'Z';
    } catch { return false; }
  }
  try {
    const o = ex.runOut('ps', ['-o', 'state=', '-p', String(pid)], { timeoutMs: 3000 });
    return !!o && /^Z/.test(o.trim());
  } catch { return false; }
}

function readCmdline(pid) {
  if (isLinux) {
    try {
      const buf = fs.readFileSync('/proc/' + pid + '/cmdline');
      return buf.toString('utf8').replace(/\0/g, ' ').trim();
    } catch { return null; }
  }
  if (isMac) {
    try {
      const o = ex.runOut('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 3000 });
      return o ? (o.trim() || null) : null;
    } catch { return null; }
  }
  if (isWindows) {
    const out = ex.runOut('wmic', ['process', 'where', 'ProcessId=' + pid, 'get', 'CommandLine', '/value'], { timeoutMs: 5000 });
    const viaWmic = parseWmicCommandLine(out);
    if (viaWmic) return viaWmic;
    {
      const ps = "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine";
      const o = ex.runOut('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 5000 });
      return parsePowerShellCommandLine(o);
    }
  }
  return null;
}

function pgrepList(pattern) {
  const out = [];
  const readCmd = (pid) => readCmdline(pid) || '';
  try {
    if (isMac) {
      const pids = (ex.runOut('pgrep', ['-f', String(pattern)], { timeoutMs: 3000 }) || '').split(/\r?\n/);
      for (const line of pids) {
        const pid = parseInt(line.trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const cmd = readCmd(pid);
        if (!cmd) continue;
        out.push({ pid, cmdline: cmd });
      }
      return out;
    }
    if (isWindows) {
      // Windows 无 pgrep：走 Win32_Process 查询（含 CommandLine），按子串匹配。
      const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      const j = ex.runOut('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 8000 }) || '';
      let arr = [];
      try { arr = JSON.parse(j); if (!Array.isArray(arr)) arr = [arr]; } catch {}
      for (const it of arr) {
        if (!it || !it.ProcessId) continue;
        const pid = Number(it.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const cmd = String(it.CommandLine || '');
        if (!cmd.includes(pattern)) continue;
        out.push({ pid, cmdline: cmd });
      }
      return out;
    }
    const res = ex.runOut('pgrep', ['-af', String(pattern)], { timeoutMs: 3000 }) || '';
    for (const line of res.split(/\r?\n/)) {
      const m = /^(\d+)\s+([\s\S]*)$/.exec(line.trim());
      if (m) out.push({ pid: Number(m[1]), cmdline: m[2] });
    }
  } catch {}
  return out;
}

module.exports = {
  linuxListeningInodes, linuxFind, macFind, winFind, linuxFindSs,
  readCmdline, pgrepList, isAlive, probeAlive, isZombie,
};
