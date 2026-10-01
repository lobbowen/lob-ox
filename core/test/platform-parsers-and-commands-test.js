#!/usr/bin/env node
'use strict';

// 平台「输出解析 + 命令构造 + 会话判定」可移植性（纯函数直调，非平行实现）：pidlookup.js 的 parse* 系列 ·
//   notify.js（notifyCommand/appleScriptString/powerShellString）· desktop.js 会话探针。
//   PowerShell 用**双写**转义、反斜杠是字面字符（套 JSON 规则会让 PS 在反斜杠处终止字符串 -> notify 静默失败）；wmic 的 "No Instance(s) Available." 必须返回 null 走 CIM 回退；端口匹配必须**整段**。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const pid = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
const notify = require(path.join(ROOT, 'src', 'platform', 'os', 'notify.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
// 异步判据登记表：汇总前统一 await。
const pendingChecks = [];
// -- Y-1：三平台监听者解析 --
{
  // Windows netstat -ano（真实形态：CRLF；IPv6 行；非 LISTENING 行）
  const netstat = [
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:2800         0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:28100        0.0.0.0:0              LISTENING       12345',
    '  TCP    127.0.0.1:28101        0.0.0.0:0              ESTABLISHED     777',
    '  TCP    [::1]:28100            [::]:0                 LISTENING       12345',
    '  TCPv6  [::]:28102             [::]:0                 LISTENING       555',
  ].join(CRLF);
  const onlyLonger = '  TCP    127.0.0.1:28100        0.0.0.0:0              LISTENING       12345'
    + CRLF + '  TCP    127.0.0.1:12800        0.0.0.0:0              LISTENING       22222';
  //  严格判据：整段匹配（:28100 不被 :2800/:12800 误命中，抓贪婪子串与前后缀干扰）+ 真实夹具上的
  //   非 LISTENING / TCPv6 / 空输入，一并判。
  check('Y-1 netstat：**:28100 取 12345 而 :2800 → null**、:12800 → 22222（抓贪婪/前后缀干扰）；非 LISTENING 忽略、TCPv6 解析、无匹配/空/undefined 一律 null',
    pid.parseNetstatPid(onlyLonger, 2800) === null
    && pid.parseNetstatPid(onlyLonger, 28100) === 12345 && pid.parseNetstatPid(onlyLonger, 12800) === 22222
    && pid.parseNetstatPid(netstat, 2800) === 9999 && pid.parseNetstatPid(netstat, 28101) === null
    && pid.parseNetstatPid(netstat, 28102) === 555 && pid.parseNetstatPid(netstat, 28999) === null
    && pid.parseNetstatPid('', 80) === null && pid.parseNetstatPid(undefined, 80) === null, 'ok');

  // macOS lsof / Linux ss / Linux /proc/net/tcp：三种形态各自的取 pid 规则（表头、无 pid 段 -> null）
  const lsof = [
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    12345 bowen   20u  IPv4 0x1a2b3c4d5e6f7a8b      0t0  TCP 127.0.0.1:28107 (LISTEN)',
  ].join(LF);
  const ssOut = 'LISTEN 0      511          0.0.0.0:28107      0.0.0.0:*    users:(("node",pid=12345,fd=20))';
  const procTcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:6DCB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000:6DCC 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 999999 1 0000000000000000 100 0 0 10 0',
  ].join(LF);
  const inodes = pid.parseProcNetTcpInodes(procTcp, 0x6DCB);
  check('Y-1 lsof 取第 2 列 pid（仅表头 -> null）；ss 取 users:(...pid=N...)（无 pid 段 -> null）；/proc/tcp 仅 0A(LISTEN) 且端口匹配入集',
    pid.parseLsofPid(lsof) === 12345 && pid.parseLsofPid('COMMAND   PID USER   FD') === null
    && pid.parseSsPid(ssOut) === 12345 && pid.parseSsPid('LISTEN 0 511 0.0.0.0:28107 0.0.0.0:*') === null
    && inodes.size === 1 && inodes.has('socket:[424242]') && pid.parseProcNetTcpInodes(procTcp, 0x6DCC).size === 0,
    JSON.stringify([...inodes]));
}

// -- Y-2：回归锚点 —— wmic 空输出必须回退 --
{
  //  核心：进程已退出/权限不足时 wmic 输出下面这句 -> 必须 null（=> 调用方走 CIM 回退）
  const noInstance = 'No Instance(s) Available.';
  check('Y-2 wmic 输出 No Instance(s) Available. → null（触发 CIM 回退）',
    pid.parseWmicCommandLine(noInstance) === null, JSON.stringify(pid.parseWmicCommandLine(noInstance)));
  check('Y-2 wmic 正常输出取 CommandLine 并 trim（内部换行保留）；空值/无输出 → null；PowerShell CIM 输出 trim、空串 → null',
    pid.parseWmicCommandLine('CommandLine=node.exe --flag  ' + CRLF + CRLF) === 'node.exe --flag'
    && pid.parseWmicCommandLine('CommandLine=a' + CRLF + 'b') === 'a' + CRLF + 'b'
    && pid.parseWmicCommandLine('CommandLine=') === null && pid.parseWmicCommandLine('') === null
    && pid.parseWmicCommandLine(null) === null && pid.parsePowerShellCommandLine('  node.exe x  ') === 'node.exe x'
    && pid.parsePowerShellCommandLine('   ') === null, 'ok');
}

// -- Y-3：notify 平台->命令映射 + 转义规则区分 --
{
  const L = notify.notifyCommand('linux', 'T', 'B');
  const D = notify.notifyCommand('darwin', 'T', 'B');
  const W = notify.notifyCommand('win32', 'T', 'B');
  check('Y-3 平台->命令映射：linux notify-send（标题/正文走 argv，无 shell 转义面）/ darwin osascript / win32 powershell；不支持平台 → null（不静默谎报已派发）',
    L && L.cmd === 'notify-send' && L.args[2] === 'T' && L.args[3] === 'B'
    && D && D.cmd === 'osascript' && /^display notification /.test(D.args[1]) && /with title /.test(D.args[1])
    && W && W.cmd === 'powershell' && W.args[0] === '-NoProfile' && /ShowBalloonTip/.test(W.args[3])
    && notify.notifyCommand('freebsd', 'T', 'B') === null,
    (W && W.cmd) || '');

  //  转义：两平台规则**不同**，必须分开实现。PowerShell 侧用**单引号字面量**——旧双引号串漏 $，
  //   body（含 err.message 通路）里的 $(...) 会被子表达式插值执行 = 注入面。
  const Q = String.fromCharCode(34);
  const SQ = String.fromCharCode(39);
  const raw = 'a' + Q + 'b';
  check('Y-3 AppleScript 用反斜杠；PowerShell 用单引号字面量（单引号双写，"、$ 均为字面字符）；win32 命令里标题即该形态',
    notify.appleScriptString(raw) === Q + 'a' + String.fromCharCode(92) + Q + 'b' + Q
    && notify.powerShellString(raw) === SQ + 'a' + Q + 'b' + SQ
    && notify.powerShellString("it's") === SQ + 'it' + SQ + SQ + 's' + SQ
    && notify.notifyCommand('win32', raw, raw).args[3]
      .indexOf('ShowBalloonTip(4000, ' + SQ + 'a' + Q + 'b' + SQ + ', ' + SQ) >= 0, 'ok');
  // 注入行为：$(...) 与反引号必须原样处于单引号内（不成为插值点）
  const inj = 'x$(calc.exe)y`z';
  const wrapped = notify.powerShellString(inj);
  check('$()/反引号 原样留在单引号串内（PowerShell 单引号语义=字面量）',
    wrapped === SQ + inj + SQ, wrapped);
}

/** 子进程伪造 platform + env 后执行（模块级：Y-4 与 Y-5 都要用）。 */
function underFakeEnv(platform, env, body) {
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    Object.entries(env).map(([k, v]) => (v === null
      ? ("delete process.env." + k + ";")
      : ("process.env." + k + " = " + JSON.stringify(v) + ";"))).join(LF),
    body,
  ].join(LF);
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000, cwd: ROOT }).trim();
  } catch (e) { return 'EXECFAIL:' + ((e && e.message) || e); }
}

// -- Y-4：desktop 会话判定 --
{
  const BODY = [
    "const d = require('./src/platform/os/desktop.js');",
    "const s = d.describe();",
    "process.stdout.write(JSON.stringify(s));",
  ].join(LF);

  // 子进程输出 -> {out, j}（JSON 解析失败时 j 为 null），下面各平台采样共用。
  const jOf = (out) => { try { return { out: out, j: JSON.parse(out) }; } catch { return { out: out, j: null }; } };

  // darwin/win32 是同一代码路径的两个平台采样（会话由启动器限定）。
  const outs = ['darwin', 'win32'].map((p) => Object.assign({ p: p }, jOf(underFakeEnv(p, { DISPLAY: null, WAYLAND_DISPLAY: null }, BODY))));
  check('Y-4 darwin/win32 恒为可用（会话由启动器限定）且 reason=session-scoped-by-launcher',
    outs.every((o) => !!o.j && o.j.available === true && o.j.reason === 'session-scoped-by-launcher'),
    outs.map((o) => o.p + ':' + (o.j ? o.j.reason : o.out.slice(0, 40))).join(' '));

  const rEnv = jOf(underFakeEnv('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: null }, BODY));
  check('Y-4 linux + DISPLAY → 可用且 reason=env(...)',
    !!rEnv.j && rEnv.j.available === true && rEnv.j.reason === 'env(DISPLAY/WAYLAND_DISPLAY)', rEnv.out.slice(0, 90));

  // 空 XDG_RUNTIME_DIR -> wayland 探针必须为假（尊重该变量）；x11 探针取决于宿主。
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const rXdg = jOf(underFakeEnv('linux', { DISPLAY: null, WAYLAND_DISPLAY: null, XDG_RUNTIME_DIR: empty }, BODY));
  const hasX = (() => { try { return fs.readdirSync('/tmp/.X11-unix').some((f) => /^X\d+$/.test(f)); } catch { return false; } })();
  check('Y-4 linux 空 XDG_RUNTIME_DIR：available === (env || x11套接字 || wayland套接字) 且 reason 不含 wayland-socket',
    !!rXdg.j && rXdg.j.available === hasX && (hasX ? rXdg.j.reason === 'x11-socket' : rXdg.j.reason === 'none'), rXdg.out.slice(0, 110));
  fs.rmSync(empty, { recursive: true, force: true });
}


// -- Y-6：resstats 进程树采样解析（/proc、ps、Get-CimInstance 三种真实形态文本离线验）--
{
  const resstats = require(path.join(ROOT, 'src', 'platform', 'os', 'resstats'));
  const { aggregate } = resstats;
  const { parseProcStat, parseProcStatusRss, parseCpuTimeMs, parsePsTable, parseCimJson } = resstats._parse;
  const line = '8421 (strange (x) proc) S 5 8421 8421 0 -1 4194304 200 0 0 0 250 125 0 0 20 0 3 0 12345';
  const ps = parseProcStat(line);
  check('Y-6 /proc stat：comm 含空格/括号仍取末个 ")" 后字段；utime+stime（USER_HZ=100）换算 ms (250+125)*10=3750；畸形输入（无括号/字段不足）-> null 不抛',
    ps && ps.pid === 8421 && ps.ppid === 5 && ps.cpuMs === 3750
    && parseProcStat('no paren here') === null && parseProcStat('1 (a) S 0 0') === null, JSON.stringify(ps));
  check('Y-6 /proc status：VmRSS 1234 kB -> 1263616 B；无 VmRSS（内核线程）-> null',
    parseProcStatusRss('Name:\tnode' + LF + 'VmRSS:\t  1234 kB' + LF) === 1234 * 1024
    && parseProcStatusRss('Name:\tkworker' + LF) === null, '');
  check('Y-6 ps cputime 大分档：mm:ss.cc → 303210ms、h:mm:ss → 3723000ms、dd-hh:mm:ss → 183845000ms；垃圾输入 -> null',
    parseCpuTimeMs('05:03.21') === 303210 && parseCpuTimeMs('1:02:03') === 3723000
    && parseCpuTimeMs('2-03:04:05') === 183845000 && parseCpuTimeMs('junk') === null,
    [parseCpuTimeMs('05:03.21'), parseCpuTimeMs('1:02:03'), parseCpuTimeMs('2-03:04:05')].join(','));
  const psTable = '  PID  PPID    RSS      TIME' + LF + '  100     1  10240    01:00' + LF + '  101   100   5120  00:30.5' + LF + '  102   999   2048    00:01' + LF;
  const procs = parsePsTable(psTable);
  const p100 = procs.find((p) => p.pid === 100);
  check('Y-6 ps 表：只留数据行（表头跳过）且 rss kB->字节、cputime->毫秒',
    procs.length === 3 && p100 && p100.rssBytes === 10240 * 1024 && p100.cpuMs === 60000, JSON.stringify(p100));
  const cim = parseCimJson('[{"ProcessId":10,"ParentProcessId":1,"WorkingSetSize":2048,"UserModeTime":1000,"KernelModeTime":2000}]');
  check('Y-6 CIM JSON：100ns->毫秒（3000/1e4=0.3）且 rss 取字节；非法 JSON -> 空表不抛',
    cim.length === 1 && cim[0].cpuMs === 0.3 && cim[0].rssBytes === 2048 && parseCimJson('not json').length === 0,
    JSON.stringify(cim));
  const tree = [
    { pid: 1, ppid: 0, rssBytes: 100, cpuMs: 10 },
    { pid: 2, ppid: 1, rssBytes: 200, cpuMs: 20 },
    { pid: 3, ppid: 2, rssBytes: 50, cpuMs: 5 },
    { pid: 4, ppid: 9, rssBytes: 999, cpuMs: 99 },
  ];
  const agg = aggregate(1, tree);
  check('Y-6 树聚合：沿父子链求和（350B/35ms）、无关进程不计；root 不在表内（已退出）-> null 不谎报零占用；竞态成环不死循环且每 pid 只计一次',
    agg && agg.rssBytes === 350 && agg.cpuMs === 35 && aggregate(12345, tree) === null
    && (() => { const c = aggregate(1, [{ pid: 1, ppid: 2, rssBytes: 10, cpuMs: 1 }, { pid: 2, ppid: 1, rssBytes: 20, cpuMs: 2 }]); return c && c.rssBytes === 30; })(),
    JSON.stringify(agg));
  // 异步段（sampleAsync 契约）：必须等它落账再收尾，防汇总先跑造成假绿跳过。
  pendingChecks.push((async () => {
    check('Y-6 sampleAsync：pid 非法（0/负/小数/字符串）-> null 不抛',
      (await resstats.sampleAsync(0)) === null && (await resstats.sampleAsync(-2)) === null &&
      (await resstats.sampleAsync(1.5)) === null && (await resstats.sampleAsync('x')) === null, '');
    const platform = require(path.join(ROOT, 'src', 'platform', 'os', 'index'));
    if (platform.isLinux) {
      const self = await resstats.sampleAsync(process.pid);
      check('Y-6 Linux 真机自采 rss>0 且 cpuMs>=0；不存在的极大 pid -> null',
        !!self && self.rssBytes > 0 && self.cpuMs >= 0
        && (await resstats.sampleAsync(2147483646)) === null, JSON.stringify(self));
    }
    // 非 Linux：子进程数据源由对应平台的 runner 裁决。
  })());
}

Promise.all(pendingChecks).then(() => {
  const failed = results.filter((r) => !r);
  console.log(LF + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
});
