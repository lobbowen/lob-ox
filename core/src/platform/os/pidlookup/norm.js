'use strict';

// pidlookup/norm.js —— 平台输出的纯解析器 + cmdline 归一化：零 IO，不 require 任何 IO 模块
// （DF-6：可独立 require 测试）。解析与 IO 分离才能在任意宿主穷举三种平台格式（平台输出差异
// 正是跨平台 bug 的藏身处），且生产代码直接调用这一份实现，不允许在带 IO 的一侧另写平行解析器。

/** 解析 /proc/net/tcp{,6} 文本，取该 port 处于 LISTEN(0A) 的 socket inode 集合。
 *  @returns {Set<string>} 形如 socket:[12345]（与 /proc/<pid>/fd 的 link 同名） */
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

/** 解析 macOS `lsof -nP -iTCP:<port> -sTCP:LISTEN` 输出 -> pid 或 null。
 *  列：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME（取首个第 2 列为数字的行）。 */
function parseLsofPid(out) {
  for (const line of String(out || '').split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.length >= 2 && /^\d+$/.test(m[1])) return Number(m[1]);
  }
  return null;
}

/** 解析 Windows netstat -ano 输出，取监听该 port 的 pid 或 null。
 *  端口必须整段相等（41000 不得被:4100 命中）；容忍 CRLF。 */
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

/** 解析 Linux `ss -tlnHp` 输出 -> `users:(("node",pid=123,fd=20))` 里的 pid 或 null。 */
function parseSsPid(out) {
  const m = out && /pid=(\d+)/.exec(String(out));
  return m ? Number(m[1]) : null;
}

/** 解析 Windows wmic ... get CommandLine /value 输出，取命令行或 null。
 *  「No Instance(s) Available.」（进程已退出/权限不足）同样返回 null，让调用方继续走
 *  PowerShell CIM 回退；在此短路 = cmdline 防线静默失效（解析不中/无输出同此）。 */
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

// 归一化 cmdline 的路径分隔符为 /。readCmdline 返回各平台原生分隔符，而本仓进程标记
// （_cmdMarks、/domains/... 字面量）按约定统一为 /；不归一化则 Windows 上永远不匹配，
// 可能误判端口异主 / 重复拉起。
function normCmdline(s) { return String(s || '').replace(/\\/g, '/'); }

module.exports = {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
  normCmdline,
};
